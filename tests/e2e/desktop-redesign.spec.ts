import { devices, expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

const qa = "/dev/t02p/qa?qaChrome=hidden&feed=calligraphy";
test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
// Playwright requires a destructured fixture parameter when only TestInfo is used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop presentation; existing mobile suites remain independent.",
  );
});

test("desktop gallery adapts CSS viewports without changing source order or image geometry", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const counts: number[] = [];
  for (const [width, height] of [
    [1024, 720],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
    [3440, 1440],
    [5120, 1440],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(qa);
    await expect(page.locator("html")).toHaveAttribute(
      "data-yoyi-boot",
      "ready",
    );
    const shell = page.locator("[data-product-shell]");
    await expect(shell).toHaveAttribute("data-desktop", "true");
    const feed = page
      .locator('[data-home-feed-panel="calligraphy"] [data-desktop-feed]')
      .first();
    await expect(feed).toHaveAttribute("data-layout-ready", "true");
    const geometry = await feed.evaluate((node) => {
      const cards = Array.from(
        node.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
      );
      const view = { w: innerWidth, h: innerHeight };
      return {
        overflow: document.documentElement.scrollWidth > view.w + 1,
        bounds: cards.map((c) => {
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }),
        visible: cards.filter((c) => {
          const r = c.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= view.h;
        }).length,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.bounds.length).toBeGreaterThan(1);
    for (let i = 0; i < geometry.bounds.length; i++) {
      const b = geometry.bounds[i]!;
      expect(b.x).toBeGreaterThanOrEqual(-1);
      expect(b.x + b.w).toBeLessThanOrEqual(width! + 1);
      expect(b.h).toBeLessThanOrEqual(721);
      const a = geometry.bounds[i - 1];
      if (a && Math.abs(a.y - b.y) < 1)
        expect(Math.abs(a.x - b.x - b.w - 12)).toBeLessThan(1);
    }
    counts.push(geometry.visible);
    await expect(feed.locator('[role="listitem"]').first()).toHaveCSS(
      "border-radius",
      "12px",
    );
    await page.screenshot({
      path: info.outputPath(`desktop-${width}.png`),
      animations: "disabled",
    });
  }
  expect(counts.at(-1)).toBeGreaterThan(counts[0]!);
  expect(errors).toEqual([]);
});

test("desktop settings persist independently across compact reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "double"),
  );
  await page.goto("/dev/t02p");
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-feed-layout", "double");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("yoyi.desktop-feed-layout.v1"),
    ),
  ).toBeNull();
  await expect(page.locator("[data-desktop-settings]")).toHaveCount(1);
  await page.locator("[data-desktop-settings]").click();
  await page.locator("[data-feed-layout-toggle]").click();
  await expect(page.locator("[data-feed-layout-toggle]")).toHaveAttribute(
    "data-feed-layout-mode",
    "single",
  );
  expect(
    await page.evaluate(() => [
      localStorage.getItem("yoyi.desktop-feed-layout.v1"),
      localStorage.getItem("yoyi.home-feed-layout.v2"),
    ]),
  ).toEqual(["single", "double"]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 800, height: 720 });
  await expect(shell).toHaveAttribute("data-desktop", "false");
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.reload();
  await expect(shell).toHaveAttribute("data-desktop", "true");
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("yoyi.desktop-feed-layout.v1"),
      localStorage.getItem("yoyi.home-feed-layout.v2"),
    ]),
  ).toEqual(["single", "double"]);
  await expect(page.locator("[data-desktop-feed]").first()).toBeVisible();
});

test("catalog detail separates the upper and lower reader and restores the gallery opener", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(qa);
  const opener = page
    .locator('[data-home-feed-panel="calligraphy"] [data-open-catalog]')
    .first();
  await opener.click();
  const detail = page.locator('[data-detail-state="loaded"]');
  await expect(
    detail.locator("[data-desktop-calligraphy-detail]"),
  ).toBeVisible();
  const upper = detail.locator("[data-desktop-detail-upper]");
  const lower = detail.locator("[data-desktop-detail-colophon]");
  await expect(upper).toBeVisible();
  const back = detail.getByRole("button", { name: "返回", exact: true });
  const rect = await back.boundingBox();
  expect(rect!.x).toBeLessThan(1440 / 2);
  if (await lower.count()) {
    const a = await upper.boundingBox(),
      b = await lower.boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
    if (await lower.locator("[data-colophon-entry]").count()) {
      const strip = lower.locator("[data-detail-reading-strip]");
      expect((await strip.boundingBox())!.height).toBeGreaterThanOrEqual(240);
    }
  }
  const image = detail.locator("[data-detail-calligraphy-media] img").first();
  if (await image.count())
    await expect(image).toHaveCSS("object-fit", "contain");
  await page.screenshot({
    path: info.outputPath("desktop-catalog-detail.png"),
    animations: "disabled",
  });
  const imageButton = detail.locator('[data-feed-slide="0"] button').first();
  if (await imageButton.count()) {
    await imageButton.click();
    const viewer = page.getByRole("dialog", { name: "图像查看" });
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).not.toBeVisible();
    await expect(detail).toBeVisible();
  }
  await back.click();
  await expect(detail).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("real tablets never adopt desktop chrome or its preference", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    ...devices["iPad Pro 11"],
    viewport: { width: 1194, height: 834 },
    ...(baseURL === undefined ? {} : { baseURL }),
  });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("yoyi.desktop-feed-layout.v1", "single");
      localStorage.setItem("yoyi.home-feed-layout.v2", "double");
    });
    const page = await context.newPage();
    await page.goto("/dev/t02p");
    await expect(page.locator("[data-product-shell]")).toHaveAttribute(
      "data-desktop",
      "false",
    );
    await expect(page.locator("[data-product-shell]")).toHaveAttribute(
      "data-feed-layout",
      "double",
    );
    await expect(page.locator("[data-desktop-navigation]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("desktop zoom equivalents keep navigation and settings reachable", async ({
  browser,
  baseURL,
}, info) => {
  // Browser zoom changes effective CSS width and pixel density together.
  // These contexts model that layout; physical display acceptance is separate.
  for (const scale of [0.8, 1.25, 2]) {
    const context = await browser.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      viewport: {
        width: Math.round(1920 / scale),
        height: Math.round(1080 / scale),
      },
      deviceScaleFactor: scale,
    });
    try {
      const page = await context.newPage();
      await page.goto(qa);
      await expect(page.locator("html")).toHaveAttribute(
        "data-yoyi-boot",
        "ready",
      );
      const gear = page.locator("[data-desktop-settings]");
      const box = await gear.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        Math.round(1080 / scale),
      );
      await gear.click();
      await expect(page.locator("[data-feed-layout-toggle]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(gear).toBeFocused();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`zoom-equivalent-${scale * 100}.png`),
        animations: "disabled",
      });
    } finally {
      await context.close();
    }
  }
});

test("formal anonymous desktop keeps navigation, publishing and settings available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  const shell = page.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  await expect(page.locator("[data-desktop-navigation]")).toBeVisible();
  await expect(page.locator("[data-create-work-action]")).toBeVisible();
  await expect(shell).toHaveAttribute("data-feed-layout", "double");
  const gear = page.locator("[data-desktop-settings]");
  await gear.click();
  await page.locator("[data-feed-layout-toggle]").click();
  await expect(page.locator("[data-feed-layout-toggle]")).toHaveAttribute(
    "data-feed-layout-mode",
    "single",
  );
  await page.keyboard.press("Escape");
  await expect(gear).toBeFocused();
  await expect(shell).toHaveAttribute("data-browse-only", "false");
});

import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

const qa = "/dev/t02p/qa?qaChrome=hidden&feed=discover";
test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, info) => {
  test.setTimeout(45_000);
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop image-first composition only",
  );
});

test("large images stay right of full-height archive reading with a below-fold colophon cue", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [width, height] of [
    [1024, 720],
    [1440, 900],
    [2560, 1440],
    [3440, 1440],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(qa);
    await page
      .locator('[data-home-feed-panel="discover"] [data-open-catalog]')
      .first()
      .click();
    const detail = page.locator('[data-detail-state="loaded"]');
    const information = detail.locator("[data-desktop-detail-information]");
    const image = detail.locator("[data-desktop-detail-image-pane]");
    const cue = detail.locator("[data-desktop-colophon-cue]");
    const lower = detail.locator("[data-desktop-detail-colophon]");
    await expect(image).toBeVisible();
    const a = (await information.boundingBox())!,
      b = (await image.boundingBox())!;
    expect(a.x + a.width).toBeLessThan(b.x);
    expect(b.width).toBeGreaterThan(a.width * 1.5);
    expect(b.height).toBeGreaterThan(height! * 0.6);
    await expect(image.locator('[data-feed-slide="0"] img')).toHaveCSS(
      "object-fit",
      "contain",
    );
    await expect(cue).toBeInViewport({ ratio: 0.9 });
    expect((await lower.boundingBox())!.y).toBeGreaterThanOrEqual(height!);
    await expect(
      detail.locator('[data-detail-reading-variant="desktop-information"]'),
    ).toHaveCount(1);
    const category = information.getByRole("tab", {
      name: "释文",
      exact: true,
    });
    await category.click();
    await expect(category).toHaveAttribute("aria-selected", "true");
    const archive = information.locator("[data-detail-reading-strip]");
    await expect(archive).toHaveCSS("scrollbar-width", "none");
    await expect(archive).toHaveCSS("writing-mode", "horizontal-tb");
    const canvasHeight = (await archive.boundingBox())!.height;
    expect(canvasHeight).toBeGreaterThan(a.height * 0.8);
    await archive.focus();
    await expect(archive).toBeFocused();
    const expanded = (await image.boundingBox())!;
    expect(expanded.width).toBeCloseTo(b.width, 1);
    expect(expanded.height).toBeCloseTo(b.height, 1);
    expect(expanded.x).toBeCloseTo(b.x, 1);
    await page.screenshot({
      path: info.outputPath(`image-first-${width}.png`),
      animations: "disabled",
    });
    await image.hover();
    await page.mouse.wheel(0, 160);
    await expect
      .poll(() =>
        page.locator("[data-detail-scroll]").evaluate((node) => node.scrollTop),
      )
      .toBeGreaterThan(0);
    await cue.click();
    const reading = lower.locator("[data-detail-reading-strip]");
    await expect(reading).toBeFocused();
    await expect(
      lower.getByRole("heading", { name: "题跋", exact: true, level: 2 }),
    ).toBeInViewport();
    expect(
      await page
        .locator("[data-detail-scroll]")
        .evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(0);
    await expect(
      lower.getByRole("navigation", { name: "题跋横向翻页" }),
    ).toBeVisible();
    const hasOverflow = await reading.evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1,
    );
    const forward = lower.getByRole("button", { name: "向左读题跋" });
    if (hasOverflow) {
      await expect(forward).toBeEnabled();
      await forward.click();
      await expect
        .poll(() => reading.evaluate((node) => Math.abs(node.scrollLeft)))
        .toBeGreaterThan(1);
      await expect(
        lower.getByRole("button", { name: "向右读题跋" }),
      ).toBeEnabled();
    } else await expect(forward).toBeDisabled();
    await page.screenshot({
      path: info.outputPath(`colophon-${width}.png`),
      animations: "disabled",
    });
  }
  expect(errors).toEqual([]);
});

test("image selection and archive category survive the viewer and detail remount", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?catalogId=runtime-inscription-multi-media#detail");
  const detail = page.locator('[data-detail-state="loaded"]');
  const media = detail.locator("[data-detail-calligraphy-media]");
  await expect(media).toBeVisible();
  await expect(detail.locator("[data-desktop-colophon-cue]")).toBeVisible();
  const category = detail.getByRole("tab", { name: "释文", exact: true });
  await category.click();
  const next = detail.getByRole("button", { name: "下一张图像", exact: true });
  await next.click();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await media.locator('[data-feed-slide="1"] button').click();
  const viewer = page.getByRole("dialog", { name: "图像查看" });
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await expect(category).toHaveAttribute("aria-selected", "true");
  await expect(
    media.locator('[data-feed-slide="1"] [data-feed-slide-image]'),
  ).toBeFocused();
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect(category).toHaveAttribute("aria-selected", "true");
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await page.screenshot({
    path: info.outputPath("viewer-return.png"),
    animations: "disabled",
  });
});

test("archive uses one native reading owner across categories and expanded reading", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?catalogId=runtime-inscription-multi-media#detail");
  const detail = page.locator('[data-detail-state="loaded"]');
  const information = detail.locator("[data-desktop-detail-information]");
  const image = detail.locator("[data-desktop-detail-image-pane]");
  const initial = (await image.boundingBox())!;
  await information.getByRole("tab", { name: "简介", exact: true }).click();
  const strip = information.locator("[data-detail-reading-strip]");
  await expect(strip).toHaveCSS("scrollbar-width", "none");
  const forward = information.getByRole("button", { name: "向左续读资料" });
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect
    .poll(() => strip.evaluate((node) => Math.abs(node.scrollLeft)))
    .toBeGreaterThan(40);
  // Let the native smooth scroll settle before navigating away from this category.
  await expect(
    information.getByRole("progressbar", { name: "资料阅读进度" }),
  ).toHaveAttribute("aria-valuenow", /^[1-9]\d*$/);
  const offset = await strip.evaluate((node) => Math.abs(node.scrollLeft));
  await information.getByRole("tab", { name: "释文", exact: true }).click();
  await information.getByRole("tab", { name: "简介", exact: true }).click();
  await expect
    .poll(() => strip.evaluate((node) => Math.abs(node.scrollLeft)))
    .toBeGreaterThan(40);
  expect(
    await strip.evaluate((node) => Math.abs(node.scrollLeft)),
  ).toBeGreaterThanOrEqual(offset - 2);
  const expand = information.getByRole("button", { name: "展开资料阅读" });
  await expand.click();
  const modal = page.getByRole("dialog", { name: "资料阅读", exact: true });
  await expect(modal).toBeVisible();
  await expect(information.locator("[data-detail-reading-strip]")).toHaveCount(
    1,
  );
  expect(
    (await modal.locator("[data-detail-reading-strip]").boundingBox())!.width,
  ).toBeGreaterThan(800);
  const after = (await image.boundingBox())!;
  expect(after.width).toBeCloseTo(initial.width, 1);
  expect(after.height).toBeCloseTo(initial.height, 1);
  await page.screenshot({
    path: info.outputPath("archive-expanded.png"),
    animations: "disabled",
  });
  await modal.getByRole("tab", { name: "背景", exact: true }).click();
  await page.goBack();
  await expect(modal).not.toBeVisible();
  await expect(detail).toBeVisible();
  await expect(
    information.getByRole("tab", { name: "背景", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(expand).toBeFocused();
  await page.screenshot({
    path: info.outputPath("archive-return.png"),
    animations: "disabled",
  });
});

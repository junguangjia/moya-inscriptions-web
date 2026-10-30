import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop reading layout only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

const detailUrl = (scenario: string) =>
  `/dev/t02p/qa?qaChrome=hidden&catalogId=qa-visual-inscription-09&commentScenario=${scenario}`;

test("colophon text uses a tall reading room at standard and large desktop heights", async ({
  page,
}, info) => {
  for (const [width, height] of [
    [1024, 720],
    [1440, 900],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(detailUrl("comment-long"));
    const detail = page.locator('[data-detail-state="loaded"]');
    const cue = detail.locator("[data-desktop-colophon-cue]");
    await expect(cue).toBeInViewport();
    await cue.click();
    const lower = detail.locator("[data-desktop-detail-colophon]");
    const strip = lower.locator("[data-detail-reading-strip]");
    await expect(
      lower.locator('[data-colophon-state="content"]'),
    ).toBeVisible();
    await expect(strip).toBeFocused();
    const box = (await strip.boundingBox())!;
    expect(box.height).toBeGreaterThan(height! * 0.7);
    expect(box.height).toBeLessThan(height!);
    await expect(strip).toHaveCSS("scrollbar-width", "none");
    await expect(
      lower.getByRole("navigation", { name: "题跋横向翻页" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`reading-room-${width}.png`),
      animations: "disabled",
    });
  }
});

test("empty colophons are compact and opening the existing writer gets full reading height", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(detailUrl("comment-empty"));
  const lower = page.locator("[data-desktop-detail-colophon]");
  await page.locator("[data-desktop-colophon-cue]").click();
  const colophon = lower.locator("[data-feed-colophon]");
  await expect(colophon).toHaveAttribute("data-colophon-state", "empty");
  await expect(colophon).toHaveCSS("writing-mode", "horizontal-tb");
  const strip = lower.locator("[data-detail-reading-strip]");
  expect((await strip.boundingBox())!.height).toBeLessThan(180);
  const emptyStatus = lower.getByText("尚无题跋", { exact: true });
  await expect(emptyStatus).toBeInViewport();
  const emptyBox = (await emptyStatus.boundingBox())!;
  const emptyStrip = (await strip.boundingBox())!;
  expect(emptyBox.y).toBeGreaterThanOrEqual(emptyStrip.y);
  expect(emptyBox.y + emptyBox.height).toBeLessThanOrEqual(
    emptyStrip.y + emptyStrip.height,
  );
  const compose = lower.getByRole("button", { name: "写题跋", exact: true });
  await expect(compose).toBeVisible();
  await page.screenshot({
    path: info.outputPath("empty-colophon.png"),
    animations: "disabled",
  });
  await compose.click();
  const input = lower.getByRole("textbox", { name: "写题跋", exact: true });
  await expect(input).toBeFocused();
  await expect
    .poll(async () => (await strip.boundingBox())!.height)
    .toBeGreaterThan(630);
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeGreaterThan(450);
  await input.fill("在足够高的题跋区中自然竖排。");
  await expect(input).toHaveValue("在足够高的题跋区中自然竖排。");
  await page.screenshot({
    path: info.outputPath("colophon-writing-room.png"),
    animations: "disabled",
  });
});

test("already loaded notes stay tall while more notes load in the existing dark theme", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.theme-preference.v2", "dark"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(detailUrl("comment-loading"));
  await page.locator("[data-desktop-colophon-cue]").click();
  const lower = page.locator("[data-desktop-detail-colophon]");
  await expect(lower.locator('[data-colophon-state="content"]')).toBeVisible();
  await expect(lower.locator("[data-colophon-skeleton]").first()).toBeVisible();
  expect(
    (await lower.locator("[data-detail-reading-strip]").boundingBox())!.height,
  ).toBeGreaterThan(630);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: info.outputPath("colophon-loading-dark.png"),
    animations: "disabled",
  });
});

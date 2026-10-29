import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

const url = "/?catalogId=runtime-inscription-multi-media#detail";

test("calligraphy shortcuts switch reading regions and follow horizontal reading", async ({
  page,
}, info) => {
  test.skip(
    info.project.name.startsWith("desktop"),
    "Calligraphy shortcuts apply to phone and tablet",
  );
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "single"),
  );
  await page.goto(url);
  const detail = page.locator('[data-detail-state="loaded"]');
  const navigation = detail.getByRole("navigation", { name: "详情与评论" });
  const information = navigation.getByRole("button", {
    name: "详情",
    exact: true,
  });
  const comments = navigation.getByRole("button", {
    name: "评论",
    exact: true,
  });
  const reading = detail.locator("[data-detail-reading-strip]");
  await expect(information).toHaveAttribute("aria-pressed", "true");
  const [commentsBounds, informationBounds] = await Promise.all([
    comments.boundingBox(),
    information.boundingBox(),
  ]);
  expect(commentsBounds).not.toBeNull();
  expect(informationBounds).not.toBeNull();
  expect(commentsBounds!.x + commentsBounds!.width).toBeLessThanOrEqual(
    informationBounds!.x + 1,
  );
  await expect(information).toHaveAttribute(
    "aria-controls",
    (await reading.getAttribute("id"))!,
  );
  if (
    (await page
      .locator("[data-product-shell]")
      .getAttribute("data-browse-only")) === "true"
  ) {
    await expect(comments).toBeDisabled();
    return;
  }
  const media = detail.locator("[data-detail-calligraphy-media]");
  await media.locator("[data-feed-post-dot]").nth(1).click();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await comments.click();
  await expect(reading).toHaveAttribute(
    "data-detail-reading-region",
    "comments",
  );
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  await information.press("Enter");
  await expect(information).toBeFocused();
  await expect(information).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => reading.evaluate((node) => Math.abs(node.scrollLeft)))
    .toBeLessThan(1);
  await comments.press("Space");
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  await reading.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 400 }));
    node.scrollLeft = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(information).toHaveAttribute("aria-pressed", "true");
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await navigation
    .locator("..")
    .screenshot({ path: info.outputPath("calligraphy-shortcuts.png") });
});

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

test("calligraphy Detail has independent complete images and a vertical content-to-colophon strip", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "single"),
  );
  await page.goto(url);
  const detail = page.locator('[data-detail-state="loaded"]');
  await expect(detail).toBeVisible();
  const mobile = (await detail.getAttribute("data-platform")) !== "pc";
  if (!mobile) {
    await expect(detail).toHaveAttribute("data-detail-mode", "calligraphy");
    await expect(
      detail.locator("[data-desktop-calligraphy-detail]"),
    ).toBeVisible();
    await expect(
      detail.locator('[data-detail-reading-variant="desktop-information"]'),
    ).toHaveCount(1);
    return;
  }
  await expect(detail).toHaveAttribute("data-detail-mode", "calligraphy");
  const media = detail.locator("[data-detail-calligraphy-media]");
  const imageStrip = media.locator("[data-feed-stage]");
  const reading = detail.locator("[data-detail-reading-strip]");
  const information = reading.locator("[data-detail-reading-information]");
  await expect(imageStrip).toHaveCSS("direction", "rtl");
  await expect(media.locator('[data-feed-slide="0"] img')).toHaveCSS(
    "object-fit",
    "contain",
  );
  await expect(media.locator("[data-feed-stage-comments]")).toHaveCount(0);
  await expect(information).toHaveCSS("writing-mode", "vertical-rl");
  await expect(information).toHaveCSS("direction", "ltr");
  await expect(reading).toHaveAttribute(
    "data-detail-reading-region",
    "information",
  );
  await expect(reading.locator("[data-detail-title]")).toHaveText(
    "运行时多图碑刻",
  );
  expect(
    await reading.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);

  await page.screenshot({
    path: info.outputPath("calligraphy-detail-top.png"),
  });
  await reading.scrollIntoViewIfNeeded();
  await reading.screenshot({
    path: info.outputPath("calligraphy-detail-reading.png"),
  });
  const imageOffset = await imageStrip.evaluate((node) => node.scrollLeft);
  if (
    (await page
      .locator("[data-product-shell]")
      .getAttribute("data-browse-only")) === "true"
  ) {
    await expect(reading.locator("[data-feed-colophon]")).toHaveCount(0);
    expect(errors).toEqual([]);
    return;
  }
  await detail.locator("[data-feed-post-comment]").click();
  await expect(reading).toHaveAttribute(
    "data-detail-reading-region",
    "comments",
  );
  await expect(reading.locator("[data-feed-colophon]")).toBeVisible();
  expect(await imageStrip.evaluate((node) => node.scrollLeft)).toBe(
    imageOffset,
  );
  await expect(detail.locator("[data-detail-content-pager]")).toHaveCount(0);
  await reading.screenshot({
    path: info.outputPath("calligraphy-detail-colophon.png"),
  });
  expect(errors).toEqual([]);
});

test("normal preference retains the existing media and information/comment composition", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("yoyi.home-feed-layout.v2", "double");
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "double");
  });
  await page.goto(url);
  const detail = page.locator('[data-detail-state="loaded"]');
  await expect(detail).toHaveAttribute("data-detail-mode", "normal");
  await expect(detail.locator("[data-detail-reading-strip]")).toHaveCount(0);
  await expect(detail.locator("[data-detail-main-stage]")).toBeVisible();
  await page.screenshot({ path: info.outputPath("normal-detail.png") });
});

test("calligraphy Viewer and re-opened Detail retain the selected image", async ({
  page,
}, info) => {
  test.skip(
    info.project.name.startsWith("desktop"),
    "Calligraphy Detail is mobile/tablet only",
  );
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "single"),
  );
  await page.goto(url);
  const detail = page.locator('[data-detail-state="loaded"]');
  const media = detail.locator("[data-detail-calligraphy-media]");
  await expect(media).toBeVisible();
  await media.locator("[data-feed-post-dot]").nth(1).click();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await media.locator('[data-feed-slide="1"] button').click();
  const viewer = page.getByRole("dialog", { name: "图像查看" });
  await expect(viewer).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator("[data-detail-viewer-index]")).toHaveText(
    "1 / 2",
  );
  await page.goBack();
  await expect(viewer).not.toBeVisible();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "0",
  );
  await expect(
    media.locator('[data-feed-slide="0"] [data-feed-slide-image]'),
  ).toBeFocused();
  await media.locator("[data-feed-post-dot]").nth(1).click();
  await expect(media.locator("[data-feed-stage]")).toHaveAttribute(
    "data-feed-stage-index",
    "1",
  );
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await page.goForward();
  await expect(
    page.locator("[data-detail-calligraphy-media] [data-feed-stage]"),
  ).toHaveAttribute("data-feed-stage-index", "1");
});

test("QA colophons share the local fixture store without live discussion requests", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "mobile-webkit",
    "The local fixture interaction needs one phone project",
  );
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/community/discussion/")
    )
      reads.push(request.url());
  });
  await page.goto(
    "/dev/t02p/qa?catalogId=qa-visual-inscription-02&qaChrome=hidden",
  );
  const reading = page.locator("[data-detail-reading-strip]");
  await expect(reading).toBeVisible();
  await reading.scrollIntoViewIfNeeded();
  await reading.screenshot({
    path: info.outputPath("qa-calligraphy-reading.png"),
  });
  const comments = page
    .getByRole("navigation", { name: "详情与评论" })
    .getByRole("button", { name: "评论", exact: true });
  await comments.click();
  await expect(comments).toHaveAttribute("aria-pressed", "true");
  await expect(reading).toHaveAttribute(
    "data-detail-reading-region",
    "comments",
  );
  const input = reading.locator("[data-colophon-input] textarea");
  await input.fill("本地题跋测试。");
  await reading
    .locator("[data-colophon-input]")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(
    reading.getByText("本地题跋测试。", { exact: true }),
  ).toBeVisible();
  expect(reads).toEqual([]);
});

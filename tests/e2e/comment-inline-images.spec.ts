import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

test.beforeAll(async ({ request }) => prepareFormalRoutes(request));
test.beforeEach(async ({ page }, info) => {
  test.setTimeout(45_000);
  const layout = info.title.startsWith("standard comments")
    ? "double"
    : "single";
  await page.addInitScript((value) => {
    localStorage.setItem("yoyi.home-feed-layout.v2", value);
    localStorage.setItem("yoyi.desktop-feed-layout.v1", value);
  }, layout);
});

async function openReading(page: Page, desktop: boolean) {
  const base =
    "/dev/t02p/qa?scenario=discover-visual&qaChrome=hidden&commentScenario=comment-inline-images";
  await page.goto(
    desktop ? `${base}&catalogId=qa-visual-inscription-01` : base,
  );
  if (desktop) {
    await page.locator("[data-desktop-colophon-cue]").click();
    const stage = page.locator(
      "[data-desktop-detail-colophon] [data-detail-reading-strip]",
    );
    await expect(stage.locator("[data-comment-image]").first()).toBeVisible();
    return stage;
  }
  const post = page.locator(
    '#home-panel-discover [data-catalog-id="qa-visual-inscription-01"][data-feed-post]',
  );
  const stage = post.locator("[data-feed-stage]");
  await post.getByRole("button", { name: "转到评论区", exact: true }).click();
  await expect(stage).toHaveAttribute("data-feed-stage-region", "comments");
  await expect(stage.locator("[data-comment-image]").first()).toBeVisible();
  return stage;
}

test("inline images retain the current home/detail reader through Viewer Back and Forward", async ({
  page,
}, info) => {
  const desktop = info.project.name.startsWith("desktop");
  const stage = await openReading(page, desktop);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(() =>
      stage.locator("[data-colophon-author]").evaluateAll((authors) => {
        if (authors.length !== 9) return Infinity;
        return Math.max(
          ...authors.map((author) => {
            const name = author.parentElement
              ?.querySelector("[data-colophon-name]")
              ?.getClientRects()[0];
            const face = author
              .querySelector("[data-comment-avatar]")
              ?.getBoundingClientRect();
            return name && face
              ? Math.abs(
                  name.left + name.width / 2 - face.left - face.width / 2,
                )
              : Infinity;
          }),
        );
      }),
    )
    .toBeLessThan(1);
  await expect(stage.locator("[data-comment-report]")).toHaveCount(9);
  const image = stage.locator("[data-comment-image]").first();
  await image.scrollIntoViewIfNeeded();
  const box = (await image.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(image).toHaveCSS("writing-mode", "horizontal-tb");
  const readPosition = () =>
    stage.evaluate((n) => {
      const surface = n.closest<HTMLElement>(
        "[data-detail-scroll], [data-home-feed-scroll-surface]",
      );
      if (!surface)
        throw new Error("The actual reader scroll owner is missing");
      return { left: n.scrollLeft, top: surface.scrollTop };
    });
  const before = await readPosition();
  const original = page.url();
  await page.screenshot({
    path: info.outputPath("inline-reader-before.png"),
    animations: "disabled",
  });
  await image.click();
  const viewer = page.getByRole("dialog", { name: "图像查看", exact: true });
  await expect(viewer).toBeVisible();
  const activeImage = viewer.locator("img[data-detail-viewer-image]");
  await expect(activeImage).toBeVisible();
  await expect
    .poll(() =>
      activeImage.evaluate((n) => {
        const image = n as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath("inline-viewer-open.png"),
    animations: "disabled",
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.history.state?.commentImageNavigation?.depth),
    )
    .toBe(1);
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(image).toBeFocused();
  expect(page.url()).toBe(original);
  const after = await readPosition();
  expect(Math.abs(after.left - before.left)).toBeLessThan(2);
  expect(Math.abs(after.top - before.top)).toBeLessThan(2);
  await expect(stage.locator("[data-colophon-input-reply]")).toHaveCount(0);
  await page.goForward();
  await expect
    .poll(() =>
      page.evaluate(() => window.history.state?.commentImageNavigation?.depth),
    )
    .toBe(0);
  await expect(viewer).toHaveCount(0);
  expect(page.url()).toBe(original);
  const forwarded = await readPosition();
  expect(Math.abs(forwarded.left - before.left)).toBeLessThan(2);
  expect(Math.abs(forwarded.top - before.top)).toBeLessThan(2);
  await page.screenshot({
    path: info.outputPath("inline-reader-return.png"),
    animations: "disabled",
  });
});

test("a mouse-pointer drag starting on an inline image neither opens it nor changes reply target", async ({
  page,
}, info) => {
  const stage = await openReading(
    page,
    info.project.name.startsWith("desktop"),
  );
  const image = stage.locator("[data-comment-image]").first();
  await image.scrollIntoViewIfNeeded();
  const box = (await image.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(
    page.getByRole("dialog", { name: "图像查看", exact: true }),
  ).toHaveCount(0);
  await expect(stage.locator("[data-colophon-input-reply]")).toHaveCount(0);
});

test("standard comments keep inline image clicks separate from the existing reply action", async ({
  page,
}) => {
  await page.goto(
    "/dev/t02p/qa?qaChrome=hidden&catalogId=qa-visual-inscription-09&commentScenario=comment-inline-images",
  );
  const detail = page.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-comment-section]")).toBeAttached();
  const pager = detail.locator("[data-detail-content-pager]");
  if (await pager.count())
    await detail.getByRole("tab", { name: /^评论/u }).click();
  const comments = detail.locator("[data-comment-section]");
  await expect(comments).toBeVisible();
  await expect(comments.locator("[data-comment-report]")).toHaveCount(9);
  const image = comments.locator("[data-comment-image]").first();
  await image.click();
  await expect(
    page.getByRole("dialog", { name: "图像查看", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "图像查看", exact: true }),
  ).toHaveCount(0);
  await expect(comments.locator("[data-comment-reply-mode]")).toHaveCount(0);
  await expect(detail).toBeVisible();
});

test("QA report flags acknowledge locally without sending a real report", async ({
  page,
}, info) => {
  const stage = await openReading(
    page,
    info.project.name.startsWith("desktop"),
  );
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/community\/.+report|\/api\/community\/reports/u.test(
        request.url(),
      )
    )
      posts.push(request.url());
  });
  const flag = stage.locator("[data-comment-report]").first();
  await expect(flag).toHaveAccessibleName("举报评论");
  await flag.click();
  await expect(flag).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("QA 演示：已标记，未提交真实举报", { exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([]);
  await expect(stage.locator("[data-colophon-input-reply]")).toHaveCount(0);
});

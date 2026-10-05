import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openDetail(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?catalogId=runtime-inscription-multi-media#detail");
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await expect(page.locator("[data-detail-state=loaded]")).toBeVisible();
  await expect(page.locator("[data-detail-content-pager]")).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    )!;
    const section = scroller.querySelector<HTMLElement>(
      "[data-detail-content-pager]",
    )!;
    const tabs = section
      .querySelector('[role="tablist"]')!
      .getBoundingClientRect();
    const header = scroller.querySelector("header")!.getBoundingClientRect();
    return {
      top: scroller.scrollTop,
      collapse:
        scroller.scrollTop +
        section.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        header.height,
      pinned: Math.abs(tabs.top - header.bottom) <= 1,
    };
  });
}
async function scrollTo(page: Page, top: number) {
  await page.evaluate((value) => {
    const scroller = document.querySelector<HTMLElement>(
      "[data-detail-scroll]",
    )!;
    // Exercise the same explicit vertical-intent path as a wheel/touch gesture.
    scroller.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        deltaY: value - scroller.scrollTop,
      }),
    );
    scroller.scrollTop = value;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, top);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function tab(page: Page, name: string) {
  const target = page.getByRole("tab", { name, exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("Missing Detail tab");
  await expect
    .poll(() =>
      target.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('[role="tab"]') === node
        );
      }),
    )
    .toBe(true);
  if (test.info().project.use.hasTouch)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(target).toHaveAttribute("aria-selected", "true");
}
async function pinned(page: Page) {
  await expect.poll(async () => (await geometry(page)).pinned).toBe(true);
}

test("Detail empty comments and information share collapse, body offsets and expansion", async ({
  page,
}) => {
  await openDetail(page);
  const longTop = (await geometry(page)).collapse + 350;
  await scrollTo(page, longTop);
  await pinned(page);
  await tab(page, "评论");
  await expect(
    page.locator('[data-detail-content-panel="comments"]'),
  ).toContainText("还没有评论");
  await pinned(page);
  await tab(page, "资料");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - longTop))
    .toBeLessThanOrEqual(1);
  await tab(page, "评论");
  await expect
    .poll(async () =>
      Number(
        await page
          .locator("[data-detail-content-frame]")
          .getAttribute("data-horizontal-pager-progress"),
      ),
    )
    .toBeCloseTo(1, 3);
  await scrollTo(page, 0);
  // Tabs are below the media when fully expanded; only reveal the hit target.
  // Moving to it vertically is itself a user expansion change, so use a horizontal
  // swipe on the content pager to verify it does not restore a stale body offset.
  await page.locator("[data-detail-content-frame]").evaluate((element) => {
    const frame = element as HTMLElement;
    for (const [type, fraction] of [
      ["touchstart", 0],
      ["touchmove", 0.35],
      ["touchmove", 0.7],
      ["touchend", 0.7],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value:
          type === "touchend"
            ? []
            : [
                {
                  identifier: 1,
                  target: frame,
                  clientX: frame.clientWidth * (0.1 + fraction),
                  clientY: 700,
                },
              ],
      });
      frame.dispatchEvent(event);
    }
  });
  await expect(
    page.getByRole("tab", { name: "资料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await geometry(page)).top).toBe(0);
  await scrollTo(page, 120);
  await tab(page, "评论");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - 120))
    .toBeLessThanOrEqual(1);
  await scrollTo(page, 100000);
  await pinned(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await pinned(page);
  await tab(page, "资料");
  await pinned(page);
});

test("Phone Detail shows complete portrait and landscape images inside a borderless 3:4 frame", async ({
  page,
}) => {
  await openDetail(page);
  const layout = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(
      "[data-detail-main-stage]",
    )!;
    const media = document.querySelector<HTMLElement>(
      "[data-detail-media-carousel]",
    )!;
    const tabs = document.querySelector(
      '[data-detail-content-pager] [role="tablist"]',
    )!;
    const style = getComputedStyle(stage);
    return {
      left: stage.getBoundingClientRect().left,
      width: stage.getBoundingClientRect().width,
      height: stage.getBoundingClientRect().height,
      images: Array.from(stage.querySelectorAll("img"), (image) => ({
        width: image.getBoundingClientRect().width,
        height: image.getBoundingClientRect().height,
        fit: getComputedStyle(image).objectFit,
        position: getComputedStyle(image).objectPosition,
      })),
      viewport: innerWidth,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      gap:
        tabs.getBoundingClientRect().top - media.getBoundingClientRect().bottom,
    };
  });
  expect(layout.left).toBe(0);
  expect(layout.width).toBe(layout.viewport);
  expect(layout.width / layout.height).toBeCloseTo(3 / 4, 3);
  for (const image of layout.images) {
    expect(image.width).toBe(layout.width);
    expect(image.height).toBe(layout.height);
    expect(image.fit).toBe("contain");
    expect(image.position).toBe("50% 50%");
  }
  expect(layout.radius).toBe("0px");
  expect(layout.shadow).toBe("none");
  expect(layout.gap).toBeLessThanOrEqual(60);
  const beforeViewer = (await geometry(page)).top;
  const mediaBox = await page
    .locator("[data-detail-main-image]")
    .first()
    .boundingBox();
  if (!mediaBox) throw new Error("Missing visible Detail media");
  if (test.info().project.use.hasTouch)
    await page.touchscreen.tap(
      mediaBox.x + mediaBox.width / 2,
      mediaBox.y + mediaBox.height / 2,
    );
  else
    await page.mouse.click(
      mediaBox.x + mediaBox.width / 2,
      mediaBox.y + mediaBox.height / 2,
    );
  const viewer = page.getByRole("dialog", { name: "图像查看" });
  await expect(viewer).toBeVisible();
  const fullImage = viewer.locator("img").first();
  await expect(fullImage).toBeVisible();
  await expect(fullImage).toHaveCSS("object-fit", "contain");
  await viewer.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(page.locator("[data-detail-state=loaded]")).toBeVisible();
  await expect.poll(async () => (await geometry(page)).top).toBe(beforeViewer);
});

test("Phone Live Photo preview and Viewer keep still and motion complete", async ({
  page,
}) => {
  // Discovery precedes startup; load the package schema after fixtures are ready.
  const { workSchema } = await import("@moya/contracts/schemas");
  const workId = `work-${"e".repeat(32)}`;
  const itemId = `media-item-${"d".repeat(32)}`;
  const mediaPath = `/api/community/publishing/media/${itemId}`;
  await page.route(`**${mediaPath}/display/base`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="#aabbcc"/></svg>',
    }),
  );
  await page.route(`**/api/community/works/${workId}`, (route) =>
    route.fulfill({
      json: workSchema.parse({
        id: workId,
        authorId: `user-${"e".repeat(32)}`,
        authorName: "实况布局测试作者",
        title: "纵向实况布局测试",
        text: "合成布局测试。",
        media: [
          {
            id: itemId,
            src: `${mediaPath}/display/base`,
            width: 600,
            height: 1000,
            kind: "live",
            motionSrc: `${mediaPath}/motion/base`,
            hasAudio: false,
          },
        ],
        firstPublishedAt: "2026-09-20T00:00:00.000Z",
        version: 1,
        canEdit: false,
        available: true,
      }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?workId=${workId}#detail`);
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  const preview = page.locator("[data-detail-main-stage]");
  await expect(preview.locator("img")).toBeVisible();
  // The active video exists before explicit playback and shares its final box.
  // This checks framing, without pretending to exercise a real motion decoder.
  await expect(preview.locator("video")).toHaveCSS("object-fit", "contain");
  await expect(preview.locator("video")).toHaveCSS(
    "object-position",
    "50% 50%",
  );
  await expect(preview.locator("img")).toHaveCSS("object-fit", "contain");
  const sizes = await preview.evaluate((stage) =>
    [...stage.querySelectorAll("img,video")].map((node) => ({
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    })),
  );
  expect(sizes).toHaveLength(2);
  expect(sizes[0]).toEqual(sizes[1]);
  await page.locator("[data-detail-main-image]").click();
  const viewer = page.getByRole("dialog", { name: "图像查看" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img").first()).toHaveCSS(
    "object-fit",
    "contain",
  );
  await expect(viewer.locator("video")).toHaveCSS("object-fit", "contain");
});

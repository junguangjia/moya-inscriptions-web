import { devices, expect, test } from "@playwright/test";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  TestInfo,
} from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

/** The fixture's official record whose post carries a two-image gallery. */
const GALLERY_POST = "runtime-inscription-multi-media";

interface PhoneFeed {
  readonly context: BrowserContext | null;
  readonly page: Page;
  readonly session: CDPSession | null;
  readonly shell: Locator;
  readonly home: Locator;
  readonly post: Locator;
  readonly strip: Locator;
}

/**
 * The formal Home feed on an iPhone. On desktop Chromium the phone is an
 * emulated context so the compositor accepts trusted touch input over CDP;
 * the mobile WebKit project uses its own page.
 */
const openPhoneFeed = async (
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
): Promise<PhoneFeed> => {
  let context: BrowserContext | null = null;
  let session: CDPSession | null = null;
  let target = page;
  if (testInfo.project.name === "desktop-chromium") {
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
    context = await browser.newContext({ ...devices["iPhone 15"], baseURL });
    target = await context.newPage();
    session = await context.newCDPSession(target);
  }
  const response = await target.goto("/");
  expect(response?.status()).toBe(200);
  await expect(target.locator("[data-product-boot]")).toHaveCount(0);
  const shell = target.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-platform", "phone");
  // Phone opens on the single-column post feed.
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  const home = target.locator("[data-home-surface]");
  const post = target.locator(
    `[data-home-feed-panel="discover"] [data-feed-post][data-content-id="${GALLERY_POST}"]`,
  );
  await post.scrollIntoViewIfNeeded();
  const strip = post.locator("[data-feed-stage]");
  await expect(strip).toHaveAttribute("data-feed-stage-count", "2");
  // Let the panel's own scroll settle before measuring any point.
  await target.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return { context, page: target, session, shell, home, post, strip };
};

const center = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Missing geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

/** A trusted single-finger horizontal drag; positive `dx` moves right. */
const trustedDrag = async (
  page: Page,
  session: CDPSession,
  from: { readonly x: number; readonly y: number },
  dx: number,
) => {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (dx * step) / 12, y: from.y }],
    });
    await page.waitForTimeout(12);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};

/** A trusted tap, which the browser turns into one click. */
const trustedTap = async (
  session: CDPSession,
  point: { readonly x: number; readonly y: number },
) => {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
};

const skipUnlessPhone = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "The post stage exists only in the phone single-column feed.",
  );
const skipUnlessTrustedTouch = (testInfo: TestInfo) =>
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Trusted compositor touch injection uses the Chromium protocol.",
  );

test("the post stage is a right-to-left native strip with the first image at the right edge", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await expect(feed.strip).toHaveCSS("direction", "rtl");
  await expect(feed.strip).toHaveCSS("scroll-snap-type", "x mandatory");
  await expect(feed.strip).toHaveCSS("overflow-x", "auto");
  expect(await feed.strip.evaluate((node) => node.scrollLeft)).toBe(0);
  await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "0");
  await expect(feed.strip).toHaveAttribute("data-local-horizontal", "");
  const first = feed.post.locator('[data-feed-slide="0"]');
  const stage = feed.post.locator("[data-feed-stage-frame]");
  const [firstBox, stageBox] = await Promise.all([
    first.boundingBox(),
    stage.boundingBox(),
  ]);
  expect(Math.abs(firstBox!.x - stageBox!.x)).toBeLessThanOrEqual(1);
  // A 3:4 first image stops the stage at 4:5.
  expect(stageBox!.height / stageBox!.width).toBeCloseTo(1.25, 1);
  // Dots for both images plus the comments seal, between stage and title.
  await expect(feed.post.locator("[data-feed-post-dot]")).toHaveCount(2);
  await expect(feed.post.locator("[data-feed-post-dot-comments]")).toHaveCount(
    1,
  );
  // Single-column posts carry no long-press layer.
  await expect(feed.post.locator("[data-quick-actions]")).toHaveCount(0);
  await feed.context?.close();
});

test("a rightward swipe on the stage pages the post, not the Home tabs", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  const session = feed.session!;
  const { box } = await center(feed.post.locator("[data-feed-stage-frame]"));
  const start = { x: box.x + box.width * 0.2, y: box.y + box.height / 2 };
  await trustedDrag(feed.page, session, start, box.width * 0.6);
  await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "1");
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(
    feed.post.locator('[data-feed-post-dot][aria-current="true"]'),
  ).toHaveAttribute("aria-label", /^第 2 张/u);

  // Past the last image the strip continues into the comments, and back.
  await trustedDrag(feed.page, session, start, box.width * 0.6);
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await expect(feed.post.locator("[data-feed-post-comments]")).toBeVisible();
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  const back = { x: box.x + box.width * 0.8, y: start.y };
  await trustedDrag(feed.page, session, back, -box.width * 0.6);
  await expect(feed.strip).toHaveAttribute("data-feed-stage-region", "media");
  await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "1");

  // A swipe outside the stage still pages the Home tabs.
  const title = await center(feed.post.locator("[data-feed-post-title]"));
  await trustedDrag(
    feed.page,
    session,
    { x: title.box.x + title.box.width * 0.85, y: title.y },
    -title.box.width * 0.6,
  );
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "nearby");
  await feed.context?.close();
});

test("a tap opens the viewer over the feed and Back closes it where it was", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  const panel = feed.page.locator('[data-home-feed-panel="discover"]');
  const scrollBefore = await panel.evaluate((node) => node.scrollTop);
  const image = feed.post.locator(
    '[data-feed-slide="0"] [data-feed-slide-image]',
  );
  if (feed.session) await trustedTap(feed.session, await center(image));
  else await image.tap();
  const viewer = feed.page.locator("[data-detail-viewer]");
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute("data-viewer-direction", "rtl");
  await expect(feed.shell).toHaveAttribute("data-viewer-open", "true");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  expect(new URL(feed.page.url()).hash).toBe("#viewer");

  await feed.page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(feed.shell).toHaveAttribute("data-viewer-open", "false");
  expect(new URL(feed.page.url()).hash).toBe("");
  await expect(image).toBeFocused();
  expect(await panel.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  await feed.context?.close();
});

test("a double tap likes instead of opening the viewer; a guest is asked to sign in", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  const image = feed.post.locator(
    '[data-feed-slide="0"] [data-feed-slide-image]',
  );
  const point = await center(image);
  await trustedTap(feed.session!, point);
  await feed.page.waitForTimeout(80);
  await trustedTap(feed.session!, point);
  await expect(feed.page.getByText("登录后可以喜欢内容")).toBeVisible();
  // Well past the double-tap window, nothing opened.
  await feed.page.waitForTimeout(600);
  await expect(feed.page.locator("[data-detail-viewer]")).toHaveCount(0);
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.context?.close();
});

test("the seal dot brings in the comments region; the comment button opens Detail on its comments", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await feed.post.locator("[data-feed-post-dot-comments]").click();
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await expect(
    feed.post.locator('[data-feed-post-dot-comments][aria-current="true"]'),
  ).toHaveCount(1);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");

  // Until the colophon comments land, comments are read on Detail's page.
  await feed.post.locator("[data-feed-post-comment]").click();
  await expect(feed.shell).toHaveAttribute("data-detail-open", "true");
  await expect(
    feed.page.locator("[data-detail-content-pager]"),
  ).toHaveAttribute("data-detail-content-active-page", "comments");

  await feed.page.goBack();
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.post.getByRole("button", { name: "打开运行时多图碑刻" }).click();
  await expect(feed.shell).toHaveAttribute("data-detail-open", "true");
  await expect(
    feed.page.locator("[data-detail-content-pager]"),
  ).toHaveAttribute("data-detail-content-active-page", "information");
  await feed.context?.close();
});

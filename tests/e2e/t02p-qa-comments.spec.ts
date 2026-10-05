import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

const openQaDetail = async (
  page: Page,
  scenario: string = "comment-default",
) => {
  const response = await page.goto(
    `/dev/t02p/qa?catalogId=qa-visual-inscription-09&commentScenario=${scenario}`,
  );
  expect(response?.status()).toBe(200);
  const detail = page.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  const contentPager = detail.locator("[data-detail-content-pager]");
  if ((await contentPager.count()) > 0) {
    await detail.getByRole("tab", { name: "评论" }).click();
    await expect(contentPager).toHaveAttribute(
      "data-detail-content-active-page",
      "comments",
    );
  }
  const comments = detail.locator("[data-comment-section]");
  await expect(comments).toBeVisible();
  await comments.scrollIntoViewIfNeeded();
  return { comments, detail };
};

test("QA comments send, reply, like, sort and reset on refresh", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { comments } = await openQaDetail(page);
  await expect(comments.locator("h2")).toHaveText("评论 6");

  const composer = comments.locator("[data-comment-composer]");
  const textarea = composer.getByRole("textbox", { name: "写下你的评论" });
  const send = composer.getByRole("button", { name: "发送" });
  await expect(send).toBeDisabled();
  await textarea.fill("  这里的字形很有意思。  ");
  await send.click();
  await expect(comments.getByText("这里的字形很有意思。")).toBeVisible();
  await expect(comments.locator("h2")).toHaveText("评论 7");
  const newComment = comments.locator('[data-comment-id^="qa-comment-local-"]');
  await expect(newComment).toHaveCount(1);

  await comments.locator("[data-comment-sort]").selectOption("latest");
  await expect(
    comments.locator("[data-comment-list] > li").first(),
  ).toHaveAttribute("data-comment-id", /qa-comment-local-/u);

  const fixtureComment = comments
    .locator('[data-comment-id$="fixture-comment-1"]')
    .first();
  const replyEntry = fixtureComment
    .locator("[data-comment-reply-action]")
    .first();
  await expect(replyEntry).toHaveAttribute("role", "button");
  await replyEntry.click();
  await expect(composer.getByRole("textbox")).toBeFocused();
  await expect(composer.locator("[data-comment-reply-mode]")).toContainText(
    "回复 墨池散人",
  );
  await composer
    .getByRole("textbox", { name: "回复 墨池散人" })
    .fill("赞同这个观察。");
  await send.click();
  await expect(fixtureComment.getByText("赞同这个观察。")).toBeVisible();
  await expect(comments.locator("h2")).toHaveText("评论 8");

  const like = fixtureComment.locator("[data-comment-like]").first();
  await like.click();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  await expect(
    comments.locator("[data-comment-list] > li").first(),
  ).toHaveAttribute("data-comment-id", /qa-comment-local-/u);

  await page.reload();
  const resetComments = page.locator("[data-comment-section]");
  await expect(resetComments.locator("h2")).toHaveText("评论 6");
  await expect(resetComments.getByText("这里的字形很有意思。")).toHaveCount(0);
  await expect(resetComments.getByText("赞同这个观察。")).toHaveCount(0);
});

test("QA comment scenarios expose deterministic empty, loading and reply states", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const manyView = await openQaDetail(page, "comment-many-replies");
  const comments = manyView.comments;
  const many = comments.locator('[data-comment-id$="fixture-comment-1"]');
  await expect(many.locator("[data-comment-reply]")).toHaveCount(2);
  const expand = many.locator("[data-comment-expand-replies]");
  await expect(expand).toContainText("展开其余 6 条回复");
  await expand.click();
  await expect(many.locator("[data-comment-reply]")).toHaveCount(8);
  await expand.click();
  await expect(many.locator("[data-comment-reply]")).toHaveCount(2);

  const empty = (await openQaDetail(page, "comment-empty")).comments;
  await expect(empty.locator("[data-comment-empty]")).toBeVisible();
  await expect(empty.locator("textarea")).toBeVisible();

  const loading = (await openQaDetail(page, "comment-loading")).comments;
  await expect(
    loading.getByRole("status", { name: "正在加载评论" }),
  ).toBeVisible();
  await expect(loading.locator("textarea, [data-comment-sort]")).toHaveCount(0);
});

test("long comments stay inside the single Detail scroller on every project", async ({
  page,
}) => {
  const { comments, detail } = await openQaDetail(page, "comment-long");
  await expect(comments).toContainText(
    "一位名字很长但仍然认真阅读碑刻资料的访客",
  );
  expect(
    await comments.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await expect(detail.locator("[data-detail-scroll]")).toHaveCount(0);
  await expect(page.locator("[data-detail-scroll]")).toHaveCount(1);
});

test("formal compositions render the live comment section over the real client", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  // Mission 2C: the Formal root and /dev/t02p compose the real comment client
  // in the Development runtime the fixture runs; the QA store never reaches
  // them. The fixture serves an empty listing and issues no session, so the
  // truthful states are "no comments yet" and signed out with the
  // current sign-in entry.
  for (const path of [
    "/?catalogId=runtime-inscription-no-media",
    "/dev/t02p?catalogId=runtime-inscription-no-media",
  ]) {
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.locator("[data-detail-experience]")).toBeVisible();
    const section = page.locator("[data-comment-section]");
    await expect(section).toHaveCount(1);
    await expect(section).toHaveAttribute("data-comment-presentation", "live");
    await expect(section.locator("[data-comment-empty]")).toBeVisible();
    await expect(
      section.locator("[data-comment-signed-out] a[href='/login']"),
    ).toBeVisible();
    await expect(section.locator("[data-comment-composer]")).toHaveCount(0);
    await expect(section.locator("[data-comment-sort]")).toHaveCount(0);
    await expect(section.locator("[data-comment-like]")).toHaveCount(0);
  }
});

test("phone and tablet page Detail content into bottom-composer comments with media thumbnails", async ({
  page,
}, testInfo) => {
  const response = await page.goto(
    "/dev/t02p/qa?catalogId=qa-visual-inscription-01&commentScenario=comment-media&qaChrome=hidden",
  );
  expect(response?.status()).toBe(200);
  const detail = page.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  const pager = detail.locator("[data-detail-content-pager]");
  const composer = detail.locator("[data-comment-composer]");

  if (
    testInfo.project.name.startsWith("desktop") ||
    testInfo.project.name === "tablet-landscape-webkit"
  ) {
    // Wide compositions: media beside the identity card, comments underneath,
    // the reading flow collapsed behind 详情, composer pinned across the width.
    await expect(pager).toHaveCount(0);
    const wideLayout = detail.locator("[data-detail-landscape-layout]");
    const media = detail.locator("[data-detail-landscape-media]");
    const information = detail.locator("[data-detail-info-panel]");
    const comments = detail.locator("[data-detail-landscape-comments]");
    const disclosure = detail.locator("[data-detail-reading-disclosure]");
    await expect(wideLayout).toBeVisible();
    await expect(comments).toBeVisible();
    await expect(composer).toHaveCSS("position", "fixed");

    const mediaBox = await media.boundingBox();
    const informationBox = await information.boundingBox();
    const commentsBox = await comments.boundingBox();
    const composerBox = await composer.boundingBox();
    const viewport = page.viewportSize();
    expect(mediaBox).not.toBeNull();
    expect(informationBox).not.toBeNull();
    expect(commentsBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(informationBox?.x ?? 0).toBeGreaterThanOrEqual(
      (mediaBox?.x ?? 0) + (mediaBox?.width ?? 0) - 1,
    );
    expect(commentsBox?.y ?? 0).toBeGreaterThanOrEqual(
      (mediaBox?.y ?? 0) + (mediaBox?.height ?? 0) - 1,
    );
    expect(commentsBox?.x ?? Infinity).toBeLessThanOrEqual(
      (mediaBox?.x ?? 0) + 1,
    );
    expect(
      Math.abs(
        (composerBox?.y ?? 0) +
          (composerBox?.height ?? 0) -
          (viewport?.height ?? 0),
      ),
    ).toBeLessThanOrEqual(2);

    if ((await disclosure.count()) > 0) {
      const firstSection = disclosure.locator("[data-detail-section]").first();
      await expect(firstSection).toBeHidden();
      await disclosure.locator("summary").click();
      await expect(firstSection).toBeVisible();
    }

    const image = detail.locator('[data-comment-media-kind="image"] img');
    const sticker = detail.locator('[data-comment-media-kind="sticker"] img');
    await expect(image).toBeVisible();
    await expect(sticker).toBeVisible();
    expect((await image.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(
      112,
    );
    expect(
      (await sticker.boundingBox())?.width ?? Infinity,
    ).toBeLessThanOrEqual(88);
    return;
  }

  await expect(pager).toHaveAttribute(
    "data-detail-content-active-page",
    "information",
  );
  const frame = pager.locator("[data-detail-content-frame]");
  await expect
    .poll(() => frame.evaluate((node) => node.scrollLeft))
    .toBeLessThanOrEqual(1);
  await expect(
    frame.locator('[data-detail-content-panel="information"]'),
  ).toHaveAttribute("data-horizontal-panel-key", "information");
  await expect(
    frame.locator('[data-detail-content-panel="comments"]'),
  ).toHaveAttribute("data-horizontal-panel-key", "comments");
  await detail.getByRole("tab", { name: "评论" }).click();
  await expect(pager).toHaveAttribute(
    "data-detail-content-active-page",
    "comments",
  );
  await expect(composer).toHaveCSS("position", "fixed");

  const composerBox = await composer.boundingBox();
  const viewport = page.viewportSize();
  expect(composerBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(
    Math.abs(
      (composerBox?.y ?? 0) +
        (composerBox?.height ?? 0) -
        (viewport?.height ?? 0),
    ),
  ).toBeLessThanOrEqual(2);

  const image = detail.locator('[data-comment-media-kind="image"] img');
  const sticker = detail.locator('[data-comment-media-kind="sticker"] img');
  await expect(image).toBeVisible();
  await expect(sticker).toBeVisible();
  const imageBox = await image.boundingBox();
  const stickerBox = await sticker.boundingBox();
  expect(imageBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(112);
  expect(stickerBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(88);

  await detail.getByRole("tab", { name: "资料" }).click();
  await expect(pager).toHaveAttribute(
    "data-detail-content-active-page",
    "information",
  );
  await expect(composer).toBeHidden();
});

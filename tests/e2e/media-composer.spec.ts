import { devices, expect, test } from "@playwright/test";
import sharp from "sharp";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  TestInfo,
} from "@playwright/test";
import type {
  CreateArticleDraftCommand,
  CreatePublishingDraftCommand,
  SavePublishingDraftCommand,
  WorkSubmissionCommand,
} from "@moya/contracts";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";

const ACTION_TIMEOUT = 10_000;

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request, "", Date.now() + 60_000);
});

/**
 * #244 r4: dock + → start → 编辑 → 发布. Community routes use synthetic
 * data; held registrations keep photos local and make upload waiting
 * deterministic. Text-only submission exercises the existing public contract.
 * Browser emulation complements the Owner's physical-device acceptance.
 */
const authorId = `user-${"7".repeat(32)}`;
const identity = {
  id: authorId,
  handle: "synthetic-composer",
  displayName: "合成作者",
};
const DRAFT_ID = `work-draft-${"d".repeat(32)}`;
const ARTICLE_ID = `article-${"a".repeat(32)}`;
const SESSION_ID = `publishing-session-${"e".repeat(32)}`;
const timestamp = "2026-10-10T11:00:00.000Z";
const session = () => ({
  id: SESSION_ID,
  state: "active",
  workId: null,
  leaseExpiresAt: "2026-10-10T12:00:00.000Z",
  createdAt: timestamp,
});

interface Fixture {
  readonly registered: () => number;
  readonly saved: () => number;
  readonly submitted: () => readonly WorkSubmissionCommand[];
  readonly articles: () => readonly CreateArticleDraftCommand[];
  readonly release: () => void;
}

const fixture = async (page: Page): Promise<Fixture> => {
  let registered = 0;
  let saved = 0;
  let draft: ReturnType<typeof draftFrom> | null = null;
  let article: ReturnType<typeof articleFrom> | null = null;
  const submitted: WorkSubmissionCommand[] = [];
  const articles: CreateArticleDraftCommand[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draftFrom = (
    command: Pick<CreatePublishingDraftCommand, "content" | "deviceClass">,
  ) => ({
    id: DRAFT_ID,
    kind: "new",
    workId: null,
    baseRevisionId: null,
    revision: saved,
    content: command.content,
    mediaItems: [],
    conflict: null,
    deviceClass: command.deviceClass,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const articleFrom = (command: CreateArticleDraftCommand) => ({
    id: ARTICLE_ID,
    ownerId: authorId,
    version: 1,
    title: command.title,
    coverRefId: command.coverRefId,
    document: command.document,
    status: "draft",
    publicVersion: null,
    updatedAt: timestamp,
    fingerprint: "a".repeat(64),
  });
  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/community/me") return route.fulfill({ json: identity });
    if (path === `/api/community/authors/${authorId}`)
      return route.fulfill({
        json: {
          ...identity,
          bio: "合成发布回归资料。",
          avatar: null,
          isOwner: true,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "public",
            likes: "public",
          },
          totals: {
            works: 0,
            following: 0,
            followers: 0,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        },
      });
    if (path === "/api/community/publishing/limits")
      return route.fulfill({
        json: {
          maxItems: 50,
          originalItemMaxBytes: 50_000_000,
          standardComponentMaxBytes: 20_000_000,
          titleMax: 200,
          bodyMax: 10_000,
        },
      });
    if (
      path === "/api/community/publishing/sessions" &&
      request.method() === "POST"
    )
      return route.fulfill({ status: 201, json: session() });
    if (/\/publishing\/sessions\/[^/]+\/heartbeat$/u.test(path))
      return route.fulfill({ json: session() });
    if (/\/publishing\/sessions\/[^/]+\/discard$/u.test(path))
      return route.fulfill({ json: { discarded: true } });
    if (
      path === "/api/community/publishing/items" &&
      request.method() === "POST"
    ) {
      registered += 1;
      await held;
      return route.fulfill({ status: 503, json: { error: {} } });
    }
    if (
      path === "/api/community/publishing/drafts" &&
      request.method() === "POST"
    ) {
      saved += 1;
      draft = draftFrom(request.postDataJSON() as CreatePublishingDraftCommand);
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === `/api/community/publishing/drafts/${DRAFT_ID}`)
      return route.fulfill({ json: draft });
    if (/\/publishing\/drafts\/[^/]+\/(save|snapshot)$/u.test(path)) {
      saved += 1;
      const command = request.postDataJSON() as SavePublishingDraftCommand;
      draft = draftFrom(command);
      return route.fulfill({ json: { status: "saved", draft } });
    }
    if (/\/publishing\/(drafts|sessions)\/[^/]+\/readiness$/u.test(path))
      return route.fulfill({
        json: {
          ready: true,
          pendingItemKeys: [],
          failedItemKeys: [],
          editKeys: {},
        },
      });
    if (
      path === "/api/community/publishing/submissions" &&
      request.method() === "POST"
    ) {
      const command = request.postDataJSON() as WorkSubmissionCommand;
      submitted.push(command);
      return route.fulfill({
        json: {
          state: "confirmed",
          requestId: command.requestId,
          workId: `work-${"b".repeat(32)}`,
          revisionId: `work-revision-${"c".repeat(32)}`,
          visibility: command.content.visibility,
          submittedAt: timestamp,
        },
      });
    }
    if (
      path === "/api/community/article-authoring" &&
      request.method() === "POST"
    ) {
      const command = request.postDataJSON() as CreateArticleDraftCommand;
      articles.push(command);
      article = articleFrom(command);
      return route.fulfill({ status: 201, json: article });
    }
    if (path === `/api/community/article-authoring/${ARTICLE_ID}`)
      return route.fulfill({ json: article });
    if (
      path === "/api/community/article-authoring" ||
      path === "/api/community/article-authoring/media"
    )
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/community/notifications/stream") return route.abort();
    if (
      path === "/api/community/publishing/drafts" ||
      /\/publishing\/drafts\/[^/]+\/history$/u.test(path)
    )
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 },
      });
    if (path === `/api/community/authors/${authorId}/works`)
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    return route.continue();
  });
  return {
    registered: () => registered,
    saved: () => saved,
    submitted: () => submitted,
    articles: () => articles,
    release: () => release(),
  };
};

interface Composer {
  readonly context: BrowserContext | null;
  readonly page: Page;
  readonly cdp: CDPSession | null;
  readonly fixture: Fixture;
  readonly editor: Locator;
  readonly strip: Locator;
}
const opened: Composer[] = [];

/** Missing controls must fail finitely: global action and test timeouts are 0. */
const present = async (locator: Locator) => {
  await expect(locator).toBeVisible({ timeout: ACTION_TIMEOUT });
  return locator;
};
const click = async (locator: Locator) => {
  await (await present(locator)).click({ timeout: ACTION_TIMEOUT });
};
const fill = async (locator: Locator, value: string) => {
  await (await present(locator)).fill(value, { timeout: ACTION_TIMEOUT });
};
const press = async (locator: Locator, key: string) => {
  await (await present(locator)).press(key, { timeout: ACTION_TIMEOUT });
};
const reveal = async (locator: Locator) => {
  await (
    await present(locator)
  ).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
};
const center = async (locator: Locator) => {
  const box = await (
    await present(locator)
  ).boundingBox({ timeout: ACTION_TIMEOUT });
  if (box === null) throw new Error("Missing visible target geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
const screen = (composer: Composer, name: string) =>
  composer.editor.locator(`[data-editor-screen="${name}"]`);
const sheet = (composer: Composer, name: string) =>
  composer.editor.locator(`[data-phone-sheet="${name}"]`);
const thumb = (composer: Composer, index: number) =>
  composer.strip.locator(`[data-edit-index="${index}"] [data-edit-thumb]`);
interface LocalPhoto {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}
const photo = async (
  name: string,
  width: number,
  height: number,
  background: string,
): Promise<LocalPhoto> => ({
  name,
  mimeType: "image/jpeg",
  buffer: await sharp({ create: { width, height, channels: 3, background } })
    .jpeg({ quality: 80 })
    .toBuffer(),
});
const photos = () =>
  Promise.all([
    photo("red.jpg", 900, 1200, "#8b2d2d"),
    photo("green.jpg", 1600, 900, "#2d6b4a"),
  ]);

const chooseFiles = async (
  page: Page,
  opener: Locator,
  files: LocalPhoto[],
) => {
  await present(opener);
  const chooser = page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT });
  await click(opener);
  const selected = await chooser;
  // The native chooser is the visible action target; its backing input is hidden.
  await selected.setFiles(files, { timeout: ACTION_TIMEOUT });
};

const openComposer = async (
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
  options: {
    readonly desktop?: boolean;
    readonly reducedMotion?: "reduce";
  } = {},
): Promise<Composer> => {
  let context: BrowserContext | null = null;
  let target = page;
  let cdp: CDPSession | null = null;
  if (testInfo.project.name === "desktop-chromium" && !options.desktop) {
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
    context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
      ...(options.reducedMotion
        ? { reducedMotion: options.reducedMotion }
        : {}),
    });
    target = await context.newPage();
    cdp = await context.newCDPSession(target);
  }
  const state = await fixture(target);
  const composer: Composer = {
    context,
    page: target,
    cdp,
    fixture: state,
    editor: target.locator("[data-publishing-editor]"),
    strip: target.locator("[data-edit-strip]"),
  };
  // Register cleanup before navigation or an assertion can fail.
  opened.push(composer);
  const response = await target.goto("/", { timeout: 30_000 });
  expect(response?.status()).toBe(200);
  await expect(target.locator("[data-product-boot]")).toHaveCount(0);
  await click(target.getByRole("button", { name: "发布内容", exact: true }));
  if (options.desktop) {
    const choice = target.getByRole("dialog", {
      name: "发布内容",
      exact: true,
    });
    await present(choice);
    await click(choice.getByRole("button", { name: "作品", exact: true }));
    await expect(
      composer.editor.locator('[data-editor-layout="desktop"]'),
    ).toBeVisible();
  } else {
    await expect(
      target.getByRole("dialog", { name: "发布内容", exact: true }),
    ).toHaveCount(0);
    await present(screen(composer, "select"));
  }
  await present(composer.editor);
  return composer;
};
const pickPhotos = async (composer: Composer) => {
  await chooseFiles(
    composer.page,
    composer.editor.getByRole("button", { name: "选择照片", exact: true }),
    await photos(),
  );
  await present(screen(composer, "edit"));
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(2);
  await expect(screen(composer, "select")).toHaveCount(0);
  await expect(
    composer.editor.locator("[data-edit-stage] img").first(),
  ).toHaveAttribute("src", /^blob:/u);
};
const publishScreen = async (composer: Composer) => {
  await click(composer.editor.locator("[data-edit-next]"));
  await present(screen(composer, "publish"));
};

test.afterEach(async () => {
  for (const composer of opened.splice(0)) {
    composer.fixture.release();
    await composer.context?.close();
  }
});

const skipUnlessPhone = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "Phone flow: Chromium touch emulation and mobile WebKit.",
  );
const skipUnlessTrustedTouch = (testInfo: TestInfo) =>
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Trusted touch injection uses Chromium CDP.",
  );

/** Trusted touch input targets a visible region and always ends the gesture. */
const trustedDrag = async (
  composer: Composer,
  target: Locator,
  dx: number,
  longPress = false,
) => {
  await reveal(target);
  const from = await center(target);
  const cdp = composer.cdp;
  if (cdp === null) throw new Error("Missing Chromium touch session");
  await present(target);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  try {
    if (longPress) {
      await expect(composer.strip).toHaveAttribute("data-sorting", "", {
        timeout: 2_000,
      });
      await expect(
        composer.strip.locator(
          '[data-edit-index="1"] [data-edit-mark="order"]',
        ),
      ).toHaveText("2");
    }
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x + (dx * step) / 12, y: from.y }],
      });
      await composer.page.waitForTimeout(16);
    }
  } finally {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
};

test("phone dock + opens the complete start screen directly", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  const start = screen(composer, "select");
  for (const name of ["选择照片", "拍照", "专题", "跳过，只发布文字", "草稿箱"])
    await expect(
      start.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(start.getByRole("switch", { name: "原图画质" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(start.locator('input[aria-label="拍照"]')).toHaveAttribute(
    "capture",
    "environment",
  );
  await expect(
    start.locator('[data-start-option="topic"] [data-icon="academic-cap"]'),
  ).toBeVisible();
  await chooseFiles(
    composer.page,
    start.getByRole("button", { name: "拍照", exact: true }),
    [await photo("camera.jpg", 900, 1200, "#8b2d2d")],
  );
  await present(screen(composer, "edit"));
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(1);
});

test("album selection goes straight to 编辑 with a red rightmost 首图 and no old grid or rail", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  await expect(composer.strip.locator("[data-edit-strip-track]")).toHaveCSS(
    "flex-direction",
    "row-reverse",
  );
  const first = await center(thumb(composer, 0));
  const second = await center(thumb(composer, 1));
  expect(first.x).toBeGreaterThan(second.x);
  await expect(thumb(composer, 0)).toHaveAttribute("aria-current", "true");
  const mark = composer.strip.locator(
    '[data-edit-index="0"] [data-edit-mark="first"]',
  );
  await expect(mark).toHaveText("首图");
  const colors = await (
    await present(mark)
  ).evaluate((node) => {
    const styles = getComputedStyle(node);
    const sample = document.createElement("span");
    sample.style.backgroundColor = styles.getPropertyValue(
      "--yoyi-color-seal-red-hover",
    );
    return {
      background: styles.backgroundColor,
      seal: sample.style.backgroundColor,
    };
  });
  expect(colors.seal).not.toBe("");
  expect(colors.background).toBe(colors.seal);
  await expect(
    composer.editor.locator(
      "[data-order-rail], [data-photo-grid], [data-media-edit-dialog], input[type=range]",
    ),
  ).toHaveCount(0);
  await expect(
    composer.editor
      .getByRole("radiogroup", { name: "裁剪比例" })
      .getByRole("radio"),
  ).toHaveCount(5);
  await expect
    .poll(composer.fixture.registered, { timeout: ACTION_TIMEOUT })
    .toBeGreaterThan(0);
});

test("current-photo sheet changes the first photo and removal can be undone", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  const secondKey = await thumb(composer, 1).getAttribute("data-edit-thumb");
  await click(thumb(composer, 1));
  await expect(thumb(composer, 1)).toHaveAttribute("aria-current", "true");
  await expect(sheet(composer, "photo-menu")).toHaveCount(0);
  await click(thumb(composer, 1));
  const menu = sheet(composer, "photo-menu");
  await present(menu);
  for (const name of ["设为首图", "前移", "后移", "移除", "取消"])
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(
    menu.getByRole("button", { name: "后移", exact: true }),
  ).toBeDisabled();
  await click(menu.getByRole("button", { name: "设为首图", exact: true }));
  await expect(thumb(composer, 0)).toHaveAttribute(
    "data-edit-thumb",
    secondKey!,
  );
  await click(thumb(composer, 0));
  await expect(
    menu.getByRole("button", { name: "设为首图", exact: true }),
  ).toBeDisabled();
  await expect(
    menu.getByRole("button", { name: "前移", exact: true }),
  ).toBeDisabled();
  await expect(
    menu.getByRole("button", { name: "封面构图", exact: true }),
  ).toBeVisible();
  await click(menu.getByRole("button", { name: "移除", exact: true }));
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(1);
  await click(
    composer.editor.getByRole("button", { name: "撤销", exact: true }),
  );
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(2);
  await expect(thumb(composer, 0)).toHaveAttribute(
    "data-edit-thumb",
    secondKey!,
  );
});

test("long-press drag reorders the RTL strip and renumbers 首图", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  const secondKey = await thumb(composer, 1).getAttribute("data-edit-thumb");
  const first = await center(thumb(composer, 0));
  const second = await center(thumb(composer, 1));
  await trustedDrag(composer, thumb(composer, 1), first.x - second.x, true);
  await expect(thumb(composer, 0)).toHaveAttribute(
    "data-edit-thumb",
    secondKey!,
  );
  await expect(
    composer.strip.locator('[data-edit-index="0"] [data-edit-mark="first"]'),
  ).toHaveText("首图");
  await expect(composer.strip).not.toHaveAttribute("data-sorting");
  await publishScreen(composer);
  await expect(
    composer.editor.locator('[data-publish-card="0"]'),
  ).toHaveAttribute("data-fit", "contain");
});

test("inline crop offers 4:5, feed guide and apply-all while cover composition stays separate", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  const ratios = composer.editor.getByRole("radiogroup", {
    name: "裁剪比例",
    exact: true,
  });
  await expect(
    ratios.getByRole("radio", { name: "原始比例", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await click(
    composer.editor.getByRole("button", { name: "动态流参考线", exact: true }),
  );
  const window = composer.editor.locator("[data-feed-window]");
  await expect(window).toHaveAttribute("data-feed-fit", "cover");
  await expect(window.locator("[data-edge]")).toHaveCount(2);
  await click(ratios.getByRole("radio", { name: "4:5", exact: true }));
  await expect(window).toHaveAttribute("data-feed-fit", "fill");
  await click(
    composer.editor.getByRole("button", { name: "应用到全部", exact: true }),
  );
  await click(thumb(composer, 1));
  await expect(
    ratios.getByRole("radio", { name: "4:5", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await click(thumb(composer, 0));
  await click(thumb(composer, 0));
  await click(
    sheet(composer, "photo-menu").getByRole("button", {
      name: "封面构图",
      exact: true,
    }),
  );
  const cover = composer.editor.getByRole("dialog", {
    name: "封面构图",
    exact: true,
  });
  await present(cover);
  await expect(cover.locator("[data-cover-stage]")).toBeVisible();
  await expect(cover.locator("input[type=range]")).toHaveCount(0);
  await click(cover.getByRole("button", { name: "完成", exact: true }));
  await expect(cover).toHaveCount(0);
  await present(screen(composer, "edit"));
});

test("发布 previews the feed right to left and card taps return to the corresponding photo", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  await publishScreen(composer);
  const strip = composer.editor.locator("[data-publish-strip]");
  await expect(strip).toHaveCSS("direction", "rtl");
  await expect(strip).toHaveAttribute("data-count", "2");
  await expect(
    composer.editor.locator('[data-publish-card="0"]'),
  ).toHaveAttribute("data-fit", "cover");
  await expect(
    composer.editor.locator('[data-publish-card="1"]'),
  ).toHaveAttribute("data-fit", "contain");
  await expect(
    composer.editor.locator('[data-publish-card="0"] img'),
  ).toHaveAttribute("src", /^blob:/u);
  await expect(
    composer.editor.locator("[data-feed-preview-caption]"),
  ).toHaveText(/^第 1 张在最右/u);
  await expect(composer.editor.locator("[data-publish-reason]")).toBeVisible();
  await expect(composer.editor.locator("[data-editor-submit]")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await press(composer.editor.locator('[data-publish-card="0"]'), "ArrowLeft");
  await expect(
    composer.editor.locator('[data-publish-card="1"]'),
  ).toBeFocused();
  await press(composer.editor.locator('[data-publish-card="1"]'), "Enter");
  await present(screen(composer, "edit"));
  await expect(thumb(composer, 1)).toHaveAttribute("aria-current", "true");
});

test("trusted swipe and reduced-motion keyboard navigation preserve the publish strip", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const composer = await openComposer(browser, page, testInfo, {
    reducedMotion: "reduce",
  });
  await pickPhotos(composer);
  await publishScreen(composer);
  const strip = composer.editor.locator("[data-publish-strip]");
  const first = composer.editor.locator('[data-publish-card="0"]');
  await present(strip);
  expect(
    await strip.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await press(first, "ArrowLeft");
  await expect(
    composer.editor.locator('[data-publish-card="1"]'),
  ).toBeFocused();
  const offset = await strip.evaluate((node) => node.scrollLeft);
  expect(offset).toBeLessThan(0);
  await press(composer.editor.locator('[data-publish-card="1"]'), "Home");
  await expect
    .poll(() => strip.evaluate((node) => node.scrollLeft), {
      timeout: ACTION_TIMEOUT,
    })
    .toBe(0);
  const from = await center(first);
  await trustedDrag(composer, first, from.box.width * 0.6);
  await expect
    .poll(() => strip.evaluate((node) => node.scrollLeft), {
      timeout: ACTION_TIMEOUT,
    })
    .toBeLessThan(0);
  await expect(screen(composer, "publish")).toBeVisible();
});

test("编辑 + exposes quality, album and camera, then appends the new photo directly", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  await click(
    composer.editor.getByRole("button", { name: "添加照片", exact: true }),
  );
  const add = sheet(composer, "add");
  await present(add);
  await expect(add.getByRole("switch", { name: "原图画质" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(
    add.getByRole("button", { name: "拍照", exact: true }),
  ).toBeVisible();
  await click(add.getByRole("switch", { name: "原图画质" }));
  await expect(add.getByRole("switch", { name: "原图画质" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await chooseFiles(
    composer.page,
    add.getByRole("button", { name: "选择照片", exact: true }),
    [await photo("blue.jpg", 900, 900, "#315c8d")],
  );
  await expect(add).toHaveCount(0);
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(3);
  await present(screen(composer, "edit"));
});

test("Back follows 发布 → 编辑 → back sheet and an upload wait can be cancelled", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await pickPhotos(composer);
  await publishScreen(composer);
  await click(
    screen(composer, "publish").getByRole("button", {
      name: "返回编辑照片",
      exact: true,
    }),
  );
  await click(
    screen(composer, "edit").getByRole("button", { name: "返回", exact: true }),
  );
  const back = sheet(composer, "edit-back");
  await present(back);
  for (const name of ["重新选择照片", "存草稿并退出", "继续编辑"])
    await expect(back.getByRole("button", { name, exact: true })).toBeVisible();
  const saved = composer.fixture.saved();
  await click(back.getByRole("button", { name: "存草稿并退出", exact: true }));
  await expect(back.locator("[data-back-action=leave]")).toContainText(
    "等待上传完成…",
  );
  await expect(back.locator("[data-wait-progress]")).toContainText(
    /已上传 0 \/ 2 项/u,
  );
  await click(back.getByRole("button", { name: "继续编辑", exact: true }));
  await expect(back).toHaveCount(0);
  await present(screen(composer, "edit"));
  expect(composer.fixture.saved()).toBe(saved);
  await click(
    screen(composer, "edit").getByRole("button", { name: "返回", exact: true }),
  );
  await click(back.getByRole("button", { name: "重新选择照片", exact: true }));
  const start = screen(composer, "select");
  await present(start);
  await expect(
    start.getByRole("button", { name: "撤销", exact: true }),
  ).toBeVisible();
  await chooseFiles(
    composer.page,
    start.getByRole("button", { name: "选择照片", exact: true }),
    [await photo("replacement.jpg", 800, 800, "#315c8d")],
  );
  await expect(composer.strip.locator("[data-edit-index]")).toHaveCount(1);
  await expect(back).toHaveCount(0);
});

test("text-only 发布 keeps reference edits, visibility, preview and explicit save before submission", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await click(
    screen(composer, "select").getByRole("button", {
      name: "跳过，只发布文字",
      exact: true,
    }),
  );
  const publish = screen(composer, "publish");
  await present(publish);
  await expect(publish.locator("[data-editor-submit]")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await fill(publish.locator('[data-editor-input="title"]'), "合成文字作品");
  await fill(publish.locator('[data-editor-input="body"]'), "第一行\n第二行");
  // Leave text entry through keyboard navigation before the pointer click:
  // blurring the growing textarea changes the layout of its tools row.
  await press(publish.locator('[data-editor-input="body"]'), "Tab");
  await expect(publish.locator('[data-editor-input="body"]')).not.toBeFocused();
  await click(publish.getByRole("radio", { name: "临摹或练习", exact: true }));
  await expect(
    publish.getByRole("radio", { name: "临摹或练习", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await click(publish.locator("[data-publish-references]"));
  const references = sheet(composer, "references");
  await fill(
    references.locator('[data-editor-input="referenceTitle"]'),
    "合成参考",
  );
  await fill(
    references.locator('[data-editor-input="originalAuthor"]'),
    "合成作者",
  );
  await fill(
    references.locator('[data-editor-input="sourceNote"]'),
    "本地合成回归资料",
  );
  await press(references.locator('[data-editor-input="sourceNote"]'), "Escape");
  await expect(references).toHaveCount(0);
  await click(publish.locator("[data-publish-references]"));
  await expect(
    references.locator('[data-editor-input="referenceTitle"]'),
  ).toHaveValue("合成参考");
  await click(references.getByRole("button", { name: "完成", exact: true }));
  await click(publish.getByRole("radio", { name: "仅自己可见", exact: true }));
  await expect(
    publish.getByRole("radio", { name: "仅自己可见", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await click(publish.getByRole("button", { name: "预览", exact: true }));
  const preview = composer.page.locator('[data-editor-preview="phone"]');
  await present(preview);
  await expect(
    preview.getByText("合成文字作品", { exact: true }),
  ).toBeVisible();
  await click(preview.getByRole("button", { name: "返回", exact: true }));
  await expect(preview).toHaveCount(0);
  await expect(
    publish.getByRole("button", { name: "预览", exact: true }),
  ).toBeFocused();
  await click(publish.getByRole("button", { name: "保存草稿", exact: true }));
  await expect
    .poll(composer.fixture.saved, { timeout: ACTION_TIMEOUT })
    .toBeGreaterThan(0);
  await expect(
    publish.getByRole("button", { name: "更多操作", exact: true }),
  ).toBeVisible();
  await expect(publish.locator("[data-editor-submit]")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await click(publish.locator("[data-editor-submit]"));
  await expect
    .poll(() => composer.fixture.submitted().length, {
      timeout: ACTION_TIMEOUT,
    })
    .toBe(1);
  expect(composer.fixture.submitted()[0]!.content).toMatchObject({
    title: "合成文字作品",
    body: "第一行\n第二行",
    visibility: "self",
    authorship: {
      kind: "copy_practice",
      referenceTitle: "合成参考",
      originalAuthor: "合成作者",
      sourceNote: "本地合成回归资料",
    },
    items: [],
  });
  await expect(composer.editor).toHaveCount(0);
});

test("专题 creates an article draft in place and Back returns to the predecessor", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await click(
    screen(composer, "select").getByRole("button", {
      name: "专题",
      exact: true,
    }),
  );
  await expect
    .poll(() => composer.fixture.articles().length, { timeout: ACTION_TIMEOUT })
    .toBe(1);
  await expect(composer.page.locator("[data-article-authoring]")).toBeVisible();
  await expect(composer.editor).toHaveCount(0);
  await expect(
    composer.page.getByRole("textbox", { name: "专题标题", exact: true }),
  ).toHaveValue("");
  expect(composer.fixture.articles()[0]).toMatchObject({
    title: "",
    coverRefId: null,
  });
  await click(
    composer.page.getByRole("button", { name: "返回草稿箱", exact: true }),
  );
  await expect(
    composer.page.locator("[data-article-authoring-host]"),
  ).toHaveCount(0);
  await expect(
    composer.page.getByRole("navigation", { name: "主要内容", exact: true }),
  ).toBeVisible();
});

test("start-screen 草稿箱 leaves the empty work and opens drafts", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const composer = await openComposer(browser, page, testInfo);
  await click(
    screen(composer, "select").getByRole("button", {
      name: "草稿箱",
      exact: true,
    }),
  );
  await expect(composer.editor).toHaveCount(0);
  await expect(composer.page.locator("[data-drafts-picker]")).toBeVisible();
  expect(composer.fixture.articles()).toHaveLength(0);
});

test("desktop preserves the entry choice, all-at-once editor, feed stage and crop dialog", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "desktop-webkit"].includes(testInfo.project.name),
    "Existing desktop editor regression.",
  );
  const composer = await openComposer(browser, page, testInfo, {
    desktop: true,
  });
  const desktop = composer.editor.locator('[data-editor-layout="desktop"]');
  await expect(desktop.locator('[data-editor-input="title"]')).toBeVisible();
  await expect(desktop.locator('[data-editor-input="body"]')).toBeVisible();
  await chooseFiles(
    composer.page,
    desktop.getByRole("button", { name: "选择文件", exact: true }),
    await photos(),
  );
  const stage = desktop.locator("[data-feed-preview-stage]");
  await expect(stage).toHaveAttribute("data-feed-stage-count", "2");
  await expect(stage).toHaveCSS("direction", "rtl");
  await expect(stage.locator('[data-feed-slide="0"]')).toHaveAttribute(
    "data-fit",
    "cover",
  );
  await expect(stage.locator('[data-feed-slide="1"]')).toHaveAttribute(
    "data-fit",
    "contain",
  );
  await expect(
    desktop.locator("[data-edit-strip], [data-editor-screen]"),
  ).toHaveCount(0);
  await click(
    desktop.getByRole("button", { name: "编辑第 1 项", exact: true }),
  );
  const dialog = composer.page.getByRole("dialog", {
    name: "编辑第 1 项",
    exact: true,
  });
  await present(dialog);
  await expect(dialog.locator("input[type=range]")).toHaveCount(0);
  await expect(dialog.locator("[data-feed-window]")).toHaveAttribute(
    "data-feed-fit",
    "cover",
  );
  await (
    await present(dialog.getByRole("radio", { name: "4:5", exact: true }))
  ).check({ timeout: ACTION_TIMEOUT });
  await expect(dialog.locator("[data-feed-window]")).toHaveAttribute(
    "data-feed-fit",
    "fill",
  );
  await click(dialog.getByRole("button", { name: "完成", exact: true }));
  await expect(dialog).toHaveCount(0);
  await expect(stage.locator('[data-feed-slide="0"]')).toHaveAttribute(
    "data-fit",
    "contain",
  );
});

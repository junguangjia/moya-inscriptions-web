import { devices, expect, test } from "@playwright/test";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Locator,
  Page,
  Request,
  TestInfo,
} from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

/** The fixture's official record whose post carries a two-image gallery. */
const GALLERY_POST = "runtime-inscription-multi-media";
const DISCUSSION_PATH = `/api/community/discussion/catalog/${GALLERY_POST}`;

// Long enough that a page of colophons runs several stage widths.
const passage = "笔势开张而结体端严，碑阴题名尤可玩味。".repeat(6);
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const reader = (n: number) => ({
  id: `user-colophon-${n}`,
  displayName: `读者${n}`,
  ...(n % 2 === 0 ? { studioName: "听雨斋" } : {}),
});
const reply = (id: string, n: number, to: number) => ({
  id,
  author: reader(n),
  text: "同感，碑阴尤佳。",
  createdAt: minutesAgo(5),
  replyTo: reader(to),
  likeCount: 0,
  liked: false,
  deleted: false,
});
const colophon = (
  id: string,
  n: number,
  replies: ReturnType<typeof reply>[] = [],
) => ({
  id,
  target: { type: "catalog", id: GALLERY_POST },
  author: reader(n),
  text: `${id}：${passage}`,
  createdAt: minutesAgo(n * 7),
  likeCount: n,
  liked: false,
  deleted: false,
  replies,
  replyTotal: replies.length,
  replyPageTotal: replies.length,
});

const HOT = ["hot-1", "hot-2"];
const FIRST_PAGE = Array.from({ length: 10 }, (_, i) => `latest-${i + 1}`);
const SECOND_PAGE = Array.from({ length: 5 }, (_, i) => `latest-${i + 11}`);

const discussionPage = (page: number) => ({
  visibleTotal: 18,
  hot:
    page === 1
      ? [colophon(HOT[0]!, 1, [reply("reply-1", 9, 1)]), colophon(HOT[1]!, 2)]
      : [],
  items: (page === 1 ? FIRST_PAGE : SECOND_PAGE).map((id, index) =>
    colophon(id, index + 3),
  ),
  total: 15,
  page,
  pageSize: 10,
  totalPages: 2,
});

/** The signed-in reader the writing journeys use. */
const READER = {
  id: "user-colophon-reader",
  handle: "colophon-reader",
  displayName: "题跋读者",
};

/** How the gallery post's discussion answers a new colophon or reply. */
interface SubmitStub {
  mode: "published" | "awaiting" | "fail";
  delayMs: number;
  /** Published colophons, newest first, shown on the next read. */
  readonly posted: ReturnType<typeof colophon>[];
  /** Every submitted body. */
  readonly bodies: unknown[];
}

interface PhoneFeedOptions {
  /** How long each read of the gallery post's thread takes. */
  readonly readDelayMs?: number;
  /** Signs the reader in (a stubbed session). */
  readonly signedIn?: boolean;
  readonly submit?: SubmitStub;
  readonly reducedMotion?: boolean;
}

const submitStub = (): SubmitStub => ({
  mode: "published",
  delayMs: 0,
  posted: [],
  bodies: [],
});

interface PhoneFeed {
  readonly context: BrowserContext | null;
  readonly page: Page;
  readonly session: CDPSession | null;
  readonly shell: Locator;
  readonly home: Locator;
  readonly post: Locator;
  readonly strip: Locator;
  /** Every discussion read the page made, for any post. */
  readonly discussionReads: Request[];
  /** The pages of the gallery post's thread that were read. */
  readonly pagesRead: number[];
}

/**
 * The formal Home feed on an iPhone, with the gallery post's thread served
 * here (the fixture's threads stay empty for every other spec). On desktop
 * Chromium the phone is an emulated context so the compositor accepts
 * trusted touch input over CDP; mobile WebKit uses its own page.
 */
const openPhoneFeed = async (
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
  /** How long each read of the gallery post's thread takes. */
  readDelayMs = 0,
  options: PhoneFeedOptions = {},
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
  if (options.reducedMotion)
    await target.emulateMedia({ reducedMotion: "reduce" });
  if (options.signedIn)
    await target.route(
      (url) => url.pathname === "/api/community/me",
      (route) => route.fulfill({ json: READER }),
    );
  const submit = options.submit;
  const discussionReads: Request[] = [];
  const pagesRead: number[] = [];
  target.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/community/discussion/")
    )
      discussionReads.push(request);
  });
  await target.route(
    (url) =>
      url.pathname === DISCUSSION_PATH ||
      url.pathname.startsWith(`${DISCUSSION_PATH}/replies/`),
    async (route) => {
      if (route.request().method() === "POST") {
        if (submit === undefined) return route.abort();
        const body = route.request().postDataJSON() as { text: string };
        submit.bodies.push(body);
        if (submit.delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, submit.delayMs));
        if (submit.mode === "fail")
          return route.fulfill({ status: 500, json: { error: {} } });
        const id = `posted-${submit.bodies.length}`;
        const item = {
          id,
          author: { id: READER.id, displayName: READER.displayName },
          text: body.text,
          createdAt: new Date().toISOString(),
          likeCount: 0,
          liked: false,
          deleted: false,
        };
        if (submit.mode === "published")
          submit.posted.unshift({
            ...item,
            target: { type: "catalog", id: GALLERY_POST },
            replies: [],
            replyTotal: 0,
            replyPageTotal: 0,
          } as unknown as ReturnType<typeof colophon>);
        return route.fulfill({
          status: submit.mode === "published" ? 201 : 202,
          json: {
            id,
            rootId: id,
            item,
            awaitingApproval: submit.mode === "awaiting",
          },
        });
      }
      const requested = Number(
        new URL(route.request().url()).searchParams.get("page") ?? "1",
      );
      pagesRead.push(requested);
      if (readDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      const answer = discussionPage(requested);
      const posted = requested === 1 ? (submit?.posted ?? []) : [];
      await route.fulfill({
        json: {
          ...answer,
          visibleTotal: answer.visibleTotal + posted.length,
          items: [...posted, ...answer.items],
        },
      });
    },
  );
  const response = await target.goto("/");
  expect(response?.status()).toBe(200);
  await expect(target.locator("[data-product-boot]")).toHaveCount(0);
  const shell = target.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-platform", "phone");
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  const home = target.locator("[data-home-surface]");
  const post = target.locator(
    `[data-home-feed-panel="discover"] [data-feed-post][data-content-id="${GALLERY_POST}"]`,
  );
  await post.scrollIntoViewIfNeeded();
  const strip = post.locator("[data-feed-stage]");
  await expect(strip).toHaveAttribute("data-feed-stage-count", "2");
  await target.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return {
    context,
    page: target,
    session,
    shell,
    home,
    post,
    strip,
    discussionReads,
    pagesRead,
  };
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

/** One rightward swipe across the stage: further left along the strip. */
const swipeOn = async (feed: PhoneFeed) => {
  const box = await feed.strip.boundingBox();
  if (box === null) throw new Error("Missing geometry");
  if (feed.session) {
    await trustedDrag(
      feed.page,
      feed.session,
      { x: box.x + box.width * 0.15, y: box.y + box.height / 2 },
      box.width * 0.7,
    );
    return;
  }
  // WebKit has no trusted touch injection: scroll the strip natively.
  await feed.strip.evaluate((node, width) => {
    node.scrollBy({ left: -width * 0.8, behavior: "instant" });
  }, box.width);
};

/** Into the colophons: a swipe past the last image, or the seal on WebKit. */
const enterColophons = async (feed: PhoneFeed) => {
  if (feed.session) {
    await swipeOn(feed);
    await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "1");
    await swipeOn(feed);
  } else {
    await feed.post.locator("[data-feed-post-dot-comments]").click();
  }
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
};

const entryIds = (feed: PhoneFeed) =>
  feed.post
    .locator("[data-colophon-entry]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.commentId ?? ""),
    );

/** The first colophon in view at the strip's right, just past the images. */
const expectFirstColophonInView = async (feed: PhoneFeed) => {
  const geometry = await feed.post.evaluate((post) => {
    const rect = (selector: string) =>
      post.querySelector(selector)!.getBoundingClientRect();
    const strip = rect("[data-feed-stage]");
    const last = rect('[data-feed-slide="1"]');
    const first = rect("[data-colophon-entry]");
    const text = rect("[data-colophon-entry] [data-colophon-text]");
    return {
      stripLeft: strip.left,
      stripRight: strip.right,
      stripWidth: strip.width,
      lastLeft: last.left,
      firstRight: first.right,
      textLeft: text.left,
    };
  });
  // Right after the last image, only the head column between them.
  expect(geometry.firstRight).toBeLessThanOrEqual(geometry.lastLeft + 1);
  expect(geometry.lastLeft - geometry.firstRight).toBeLessThan(
    geometry.stripWidth * 0.6,
  );
  // And shown at once, without another swipe: its text inside the stage
  // (its replies may run on past the stage's left edge).
  expect(geometry.firstRight).toBeLessThanOrEqual(geometry.stripRight + 1);
  expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.stripLeft - 1);
};

const skipUnlessPhone = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "The colophons exist only in the phone single-column feed.",
  );

test("the colophons continue right after the last image, vertical, hot then latest, read only on approach", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  // The feed loads without a single discussion read.
  await feed.page.waitForTimeout(800);
  expect(feed.discussionReads).toHaveLength(0);

  await enterColophons(feed);
  const colophon = feed.post.locator("[data-feed-colophon]");
  await expect(colophon).toBeVisible();
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  expect(feed.pagesRead).toEqual([1]);
  await expect(colophon).toHaveCSS("writing-mode", "vertical-rl");
  await expect(feed.post.locator("[data-colophon-text]").first()).toHaveCSS(
    "writing-mode",
    "vertical-rl",
  );
  await expectFirstColophonInView(feed);

  // Hot first, then the latest, read right to left.
  expect(await entryIds(feed)).toEqual([...HOT, ...FIRST_PAGE]);
  const groups = feed.post.locator("[data-colophon-group]");
  await expect(groups).toHaveText(["热评", "最新"]);
  const rights = await feed.post
    .locator("[data-colophon-entry]")
    .evaluateAll((nodes) =>
      nodes.slice(0, 4).map((node) => node.getBoundingClientRect().right),
    );
  for (let index = 1; index < rights.length; index += 1)
    expect(rights[index]!).toBeLessThan(rights[index - 1]!);
  // A reply is a small annotation led by 回复 X：.
  await expect(
    feed.post.locator(
      '[data-comment-reply="reply-1"] [data-colophon-reply-lead]',
    ),
  ).toHaveText(/回复\s*读者1：/u);

  // A guest reads and is invited to sign in to write.
  await expect(
    colophon.locator("[data-colophon-head] [data-colophon-sign-in]"),
  ).toHaveText("登录后题跋");
  await expect(colophon.locator("[data-colophon-head]")).toContainText("题跋");
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.context?.close();
});

test("swiping on through the colophons reads the next page with no button", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  expect(feed.pagesRead).toEqual([1]);

  for (let swipe = 0; swipe < 24 && !feed.pagesRead.includes(2); swipe += 1) {
    await swipeOn(feed);
    await feed.page.waitForTimeout(250);
  }
  expect(feed.pagesRead).toEqual([1, 2]);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(17);
  expect(await entryIds(feed)).toEqual([...HOT, ...FIRST_PAGE, ...SECOND_PAGE]);
  // Nothing to press: the end only closes the thread.
  await expect(
    feed.post.locator("[data-feed-colophon] button", {
      hasText: /更多|加载|查看/u,
    }),
  ).toHaveCount(0);
  await expect(feed.post.locator("[data-colophon-done]")).toHaveText(
    "题跋至此",
  );
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await feed.context?.close();
});

test("a page that lands while the strip moves never throws the reader on", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  // The read starts as the last image comes in and lands during the swipe's
  // animation and snap: the strip must not grow under the moving view.
  const feed = await openPhoneFeed(browser, page, testInfo, 150);
  const offset = () =>
    feed.strip.evaluate((node) => Math.round(Math.abs(node.scrollLeft)));
  const width = await feed.strip.evaluate((node) => node.clientWidth);
  const step = () =>
    feed.strip.evaluate((node) =>
      node.scrollBy({ left: -node.clientWidth, behavior: "smooth" }),
    );
  await step();
  await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "1");
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.page.waitForTimeout(400);
  expect(feed.pagesRead).toEqual([1]);
  // Still on the last image, however wide the colophons grew past it.
  expect(await offset()).toBe(width);
  await expect(feed.strip).toHaveAttribute("data-feed-stage-region", "media");
  // The next swipe ends on the colophons' start, not deep in the thread.
  await step();
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await feed.page.waitForTimeout(400);
  expect(await offset()).toBe(width * 2);
  await expectFirstColophonInView(feed);
  expect(feed.pagesRead).toEqual([1]);
  await feed.context?.close();
});

test("the comment button scrolls the stage to the first colophon", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await expect(feed.strip).toHaveAttribute("data-feed-stage-index", "0");
  await feed.page.waitForTimeout(400);
  expect(feed.discussionReads).toHaveLength(0);

  // The action row in plain view, clear of the floating dock.
  const comment = feed.post.locator("[data-feed-post-comment]");
  await comment.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await expect(comment).toBeInViewport({ ratio: 1 });
  await comment.click();
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await expectFirstColophonInView(feed);
  // Never Detail, and no composer opens by itself.
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  expect(new URL(feed.page.url()).hash).toBe("");
  await expect(
    feed.page.locator('[data-colophon-composer-outlet] [data-open="true"]'),
  ).toHaveCount(0);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await feed.context?.close();
});

// Writing a colophon: the invite slip in the head and the vertical draft.

const slipOf = (feed: PhoneFeed) =>
  feed.post.locator("[data-colophon-head] [data-colophon-invite]");
const sheetOf = (feed: PhoneFeed, slot = "head") =>
  feed.post.locator(`[data-colophon-draft="${slot}"]`);
const openComposer = (feed: PhoneFeed) =>
  feed.page.locator('[data-colophon-composer][data-open="true"]');

/** A tap on the slip, as the reader's own gesture inside the Home pager. */
const tapSlip = async (feed: PhoneFeed) => {
  await feed.post
    .locator("[data-colophon-head] [data-colophon-write]")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(openComposer(feed)).toHaveCount(1);
};

const stripOffset = (feed: PhoneFeed) =>
  feed.strip.evaluate((node) => Math.abs(node.scrollLeft));

test("entering the colophons, a guest sees where to sign in and write", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  const slip = slipOf(feed);
  await expect(slip).toHaveAttribute("data-colophon-invite", "signed-out");
  await expect(slip).toHaveText("登录后题跋");
  await expect(slip).toHaveAttribute("href", /.+/u);
  await expect(slip).toBeInViewport({ ratio: 1 });
  await expectFirstColophonInView(feed);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.context?.close();
});

test("entering the colophons, a reader is invited to write with their own avatar", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await feed.page.waitForTimeout(800);
  expect(feed.discussionReads).toHaveLength(0);
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  const slip = slipOf(feed);
  await expect(slip).toHaveAttribute("data-colophon-invite", "signed-in");
  await expect(slip).toHaveAccessibleName("在此写题跋");
  await expect(slip.locator("[data-colophon-invite-face]")).toHaveText("题");
  await expect(slip).toBeInViewport({ ratio: 1 });
  await expectFirstColophonInView(feed);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  expect(new URL(feed.page.url()).hash).toBe("");
  await feed.context?.close();
});

test("the slip turns into a vertical draft that follows the typing while the strip stays still", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.page.waitForTimeout(400);
  await tapSlip(feed);
  const sheet = sheetOf(feed);
  await expect(sheet).toBeVisible();
  await expect(
    feed.post.locator("[data-colophon-head] [data-colophon-write]"),
  ).toHaveAttribute("aria-expanded", "true");
  await feed.page.waitForTimeout(400);
  const before = await stripOffset(feed);
  await feed.post.evaluate((post) => {
    const target = window as unknown as { __colophonMutations: number };
    target.__colophonMutations = 0;
    const observer = new MutationObserver((records) => {
      target.__colophonMutations += records.length;
    });
    for (const list of post.querySelectorAll("[data-colophon-list]"))
      observer.observe(list, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
  });
  const longTasks = feed.page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let longest = 0;
        if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
          resolve(-1);
          return;
        }
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            longest = Math.max(longest, entry.duration);
        });
        observer.observe({ type: "longtask" });
        (window as unknown as { __stopLongTasks: () => void }).__stopLongTasks =
          () => {
            observer.disconnect();
            resolve(longest);
          };
      }),
  );
  const draft = "题跋测试 10月9日";
  await feed.page.keyboard.type(draft);
  await expect(sheet).toContainText(draft);
  await expect(sheet).toHaveCSS("writing-mode", "vertical-rl");
  await expect(sheet.locator("[data-colophon-draft-status]")).toHaveText(
    "草稿",
  );
  await expect(sheet).toContainText(READER.displayName);
  expect(Math.abs((await stripOffset(feed)) - before)).toBeLessThanOrEqual(1);

  await feed.page.keyboard.type("长".repeat(300));
  await expect(sheet.locator("[data-colophon-draft-text]")).toHaveAttribute(
    "data-overflow",
    "true",
  );
  if (testInfo.project.name === "desktop-chromium") {
    await feed.page.evaluate(() =>
      (window as unknown as { __stopLongTasks: () => void }).__stopLongTasks(),
    );
    expect(await longTasks).toBeLessThanOrEqual(50);
  }
  // The box grew to three whole lines and shows where the writing goes on.
  const field = await openComposer(feed)
    .locator("textarea")
    .evaluate((node) => {
      const box = node as HTMLTextAreaElement;
      const line = Number.parseFloat(getComputedStyle(box).lineHeight);
      return {
        height: box.offsetHeight,
        line,
        end: box.scrollTop + box.clientHeight >= box.scrollHeight - 1,
      };
    });
  expect(field.height).toBeGreaterThan(2 * field.line);
  expect(field.height).toBeLessThan(4 * field.line + 24);
  expect(field.end).toBe(true);
  const geometry = await feed.post.evaluate((post) => {
    const stage = post
      .querySelector("[data-feed-stage]")!
      .getBoundingClientRect();
    const pen = post
      .querySelector("[data-colophon-draft-pen]")!
      .getBoundingClientRect();
    const column = post
      .querySelector('[data-colophon-draft="head"] > span')!
      .getBoundingClientRect();
    const form = document
      .querySelector('[data-colophon-composer][data-open="true"]')!
      .getBoundingClientRect();
    return {
      stage: [stage.left, stage.right],
      pen: [pen.left, pen.right],
      columnBottom: column.bottom,
      formTop: form.top,
    };
  });
  expect(geometry.pen[0]!).toBeGreaterThanOrEqual(geometry.stage[0]! - 1);
  expect(geometry.pen[1]!).toBeLessThanOrEqual(geometry.stage[1]! + 1);
  expect(geometry.columnBottom).toBeLessThanOrEqual(geometry.formTop + 1);
  expect(Math.abs((await stripOffset(feed)) - before)).toBeLessThanOrEqual(1);
  expect(
    await feed.page.evaluate(
      () =>
        (window as unknown as { __colophonMutations: number })
          .__colophonMutations,
    ),
  ).toBe(0);
  // The preview is for the eyes: the box is the text, and says so.
  const box = openComposer(feed).locator("textarea");
  await expect(box).toHaveAccessibleDescription(
    "输入内容会在上方题跋中竖排预览",
  );
  expect(
    await feed.post.locator("[data-feed-colophon]").ariaSnapshot(),
  ).not.toContain("题跋测试");
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.context?.close();
});

test("a reply is drafted as the replied colophon's last annotation", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  const root = feed.post.locator(
    '[data-colophon-list="latest"] [data-comment-id="latest-1"]',
  );
  await root
    .locator("[data-colophon-text]")
    .first()
    .evaluate((node) => (node as HTMLElement).click());
  await root
    .locator("[data-colophon-reply]")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(openComposer(feed)).toHaveCount(1);
  await feed.page.keyboard.type("同感，碑阴尤佳");
  const sheet = root.locator('[data-colophon-draft="reply"]');
  await expect(sheet).toContainText("回复 读者3：同感，碑阴尤佳");
  expect(
    await root.evaluate((node) =>
      node.lastElementChild?.matches("[data-colophon-draft-replies]"),
    ),
  ).toBe(true);
  await expect(feed.post.locator("[data-colophon-draft]")).toHaveCount(1);
  await feed.page.waitForTimeout(600);
  const inView = await feed.post.evaluate((post) => {
    const stage = post
      .querySelector("[data-feed-stage]")!
      .getBoundingClientRect();
    const node = post
      .querySelector('[data-colophon-draft="reply"]')!
      .getBoundingClientRect();
    return node.left >= stage.left - 1 && node.right <= stage.right + 1;
  });
  expect(inView).toBe(true);
  await feed.context?.close();
});

test("sending: 发送中, then the sheet leaves and the new colophon is marked in 最新", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const submit = submitStub();
  submit.delayMs = 900;
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
    submit,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await tapSlip(feed);
  await feed.page.keyboard.type("新题一则");
  await openComposer(feed)
    .locator("[data-colophon-composer-send]")
    .evaluate((node) => (node as HTMLElement).click());
  const sheet = sheetOf(feed);
  await expect(sheet).toHaveAttribute("data-draft-state", "sending");
  await expect(sheet.locator("[data-colophon-draft-status]")).toHaveText(
    "发送中",
  );
  await expect(sheet).toHaveCount(0);
  const posted = feed.post.locator('[data-comment-id="posted-1"]');
  await expect(posted).toHaveCount(1);
  await expect(posted).toHaveAttribute("data-colophon-highlight", "true");
  expect(
    await posted.evaluate((node) =>
      node.closest("[data-colophon-list]")?.getAttribute("data-colophon-list"),
    ),
  ).toBe("latest");
  await feed.page.waitForTimeout(700);
  const shown = await feed.post.evaluate((post) => {
    const stage = post
      .querySelector("[data-feed-stage]")!
      .getBoundingClientRect();
    const node = post
      .querySelector('[data-comment-id="posted-1"]')!
      .getBoundingClientRect();
    return node.right <= stage.right + 1 && node.right > stage.left;
  });
  expect(shown).toBe(true);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(13);
  await expect(
    feed.page.locator("[data-colophon-notice]", { hasText: "已发送" }),
  ).toHaveCount(1);
  await expect(openComposer(feed)).toHaveCount(0);
  expect(submit.bodies).toEqual([{ text: "新题一则", mentions: [] }]);
  await feed.context?.close();
});

test("awaiting approval the sheet leaves with nothing inserted; a failure keeps it, 未发出", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const submit = submitStub();
  submit.mode = "awaiting";
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
    submit,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await tapSlip(feed);
  await feed.page.waitForTimeout(400);
  const head = () =>
    feed.post
      .locator("[data-colophon-head]")
      .evaluate((node) => Math.round(node.getBoundingClientRect().right));
  const headRight = await head();
  await feed.page.keyboard.type("待审之题");
  await openComposer(feed)
    .locator("[data-colophon-composer-send]")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(sheetOf(feed)).toHaveCount(0);
  await expect(openComposer(feed)).toHaveCount(0);
  await expect(
    feed.page.locator("[data-colophon-notice]", { hasText: "已发送" }),
  ).toHaveCount(1);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.page.waitForTimeout(400);
  expect(Math.abs((await head()) - headRight)).toBeLessThanOrEqual(1);

  submit.mode = "fail";
  await tapSlip(feed);
  await feed.page.keyboard.type("发不出的题");
  await openComposer(feed)
    .locator("[data-colophon-composer-send]")
    .evaluate((node) => (node as HTMLElement).click());
  const sheet = sheetOf(feed);
  await expect(sheet.locator("[data-colophon-draft-status]")).toHaveText(
    "未发出",
  );
  await expect(sheet).toContainText("发不出的题");
  await expect(openComposer(feed)).toHaveCount(1);
  await expect(openComposer(feed).locator("textarea")).toHaveValue(
    "发不出的题",
  );
  await feed.context?.close();
});

test("取消 puts the slip back as 续写题跋, and the draft returns with it", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await tapSlip(feed);
  await feed.page.keyboard.type("未竟之题");
  await openComposer(feed)
    .locator("[data-colophon-composer-cancel]")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(openComposer(feed)).toHaveCount(0);
  await expect(sheetOf(feed)).toHaveCount(0);
  const slip = slipOf(feed);
  await expect(slip).toContainText("续写题跋");
  await expect(slip).toBeFocused();
  await tapSlip(feed);
  await expect(sheetOf(feed)).toContainText("未竟之题");
  await feed.context?.close();
});

test("opened low on the screen, the draft's column still ends above the composer", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  // The stage's top near the screen's foot: the bar will cover most of it.
  await feed.post.evaluate((post) => {
    let scroller = post.parentElement;
    while (
      scroller !== null &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 2 &&
        /auto|scroll/u.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    const stage = post.querySelector("[data-feed-stage]")!;
    scroller!.scrollTop +=
      stage.getBoundingClientRect().top - (window.innerHeight - 230);
  });
  await feed.page.waitForTimeout(300);
  await tapSlip(feed);
  await feed.page.keyboard.type("低处起笔");
  await feed.page.waitForTimeout(1500);
  const band = await feed.post.evaluate((post) => {
    const column = post.querySelector<HTMLElement>(
      '[data-colophon-draft="head"] > span',
    )!;
    const form = document
      .querySelector('[data-colophon-composer][data-open="true"]')!
      .getBoundingClientRect();
    const rect = column.getBoundingClientRect();
    return {
      height: rect.height,
      bottom: rect.bottom,
      formTop: form.top,
      sixEm: 6 * Number.parseFloat(getComputedStyle(column).fontSize),
    };
  });
  expect(band.height).toBeGreaterThanOrEqual(band.sixEm - 1);
  expect(band.bottom).toBeLessThanOrEqual(band.formTop + 1);
  await expect(openComposer(feed)).toHaveCount(1);
  await expect(sheetOf(feed)).toContainText("低处起笔");
  await feed.context?.close();
});

test("the keyboard lifting the bar over a post low on the screen never closes the composer", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  // The post's top at 330 px: above the bar as it opens, under it once the
  // keyboard has lifted the bar.
  await feed.post.evaluate((post) => {
    let scroller = post.parentElement;
    while (
      scroller !== null &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 2 &&
        /auto|scroll/u.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    scroller!.scrollTop += post.getBoundingClientRect().top - 330;
  });
  await feed.page.waitForTimeout(300);
  await tapSlip(feed);
  await feed.page.keyboard.type("键盘起");
  const size = feed.page.viewportSize();
  if (size === null) throw new Error("Missing viewport");
  // The keyboard, as the layout sees it: the viewport loses its foot.
  await feed.page.setViewportSize({
    width: size.width,
    height: size.height - 290,
  });
  await feed.page.waitForTimeout(1500);
  await expect(openComposer(feed)).toHaveCount(1);
  await expect(openComposer(feed).locator("textarea")).toBeFocused();
  await expect(sheetOf(feed)).toContainText("键盘起");
  const placed = await feed.post.evaluate((post) => {
    const form = document
      .querySelector('[data-colophon-composer][data-open="true"]')!
      .getBoundingClientRect();
    const column = post
      .querySelector('[data-colophon-draft="head"] > span')!
      .getBoundingClientRect();
    return {
      postTop: post.getBoundingClientRect().top,
      formTop: form.top,
      columnHeight: column.height,
      sixEm:
        6 *
        Number.parseFloat(
          getComputedStyle(
            post.querySelector('[data-colophon-draft="head"] > span')!,
          ).fontSize,
        ),
    };
  });
  // The one-time nudge brought the post back above the bar.
  expect(placed.postTop).toBeLessThan(placed.formTop);
  expect(placed.columnHeight).toBeGreaterThanOrEqual(placed.sixEm - 1);
  await feed.page.setViewportSize(size);
  await feed.page.waitForTimeout(600);
  await expect(openComposer(feed)).toHaveCount(1);
  await feed.context?.close();
});

test("under reduced motion the slip, the sheet and the pen stay still", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
    reducedMotion: true,
  });
  await enterColophons(feed);
  const slip = slipOf(feed);
  // Without motion the entry cue is skipped altogether: no mark, no ink.
  await expect(slip).not.toHaveAttribute("data-colophon-invite-cue");
  await expect(slip).toHaveCSS("animation-name", "none");
  await tapSlip(feed);
  await expect(sheetOf(feed)).toHaveCSS("animation-name", "none");
  const pen = sheetOf(feed).locator("[data-colophon-draft-pen]");
  await expect(pen).toHaveAttribute("data-focused", "");
  await expect(pen).toHaveCSS("animation-name", "none");
  await feed.context?.close();
});

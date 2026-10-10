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
  /** Changes each read's answer, e.g. a longer colophon or a longer name. */
  readonly adjust?: (answer: ReturnType<typeof discussionPage>) => void;
  /** A phone other than the iPhone 15's 393 × 852. */
  readonly viewport?: { readonly width: number; readonly height: number };
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
    context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
      ...(options.viewport === undefined
        ? {}
        : { viewport: options.viewport, screen: options.viewport }),
    });
    target = await context.newPage();
    session = await context.newCDPSession(target);
  }
  if (options.reducedMotion)
    await target.emulateMedia({ reducedMotion: "reduce" });
  if (options.viewport !== undefined && context === null)
    await target.setViewportSize(options.viewport);
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
      options.adjust?.(answer);
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
    const column = rect("[data-colophon-input]");
    return {
      columnRight: column.right,
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
  // Clear of the input column pinned over the stage's left edge.
  expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.columnRight - 1);
};

const SIGNED_AT_LEFT = {
  startsWithFirst: true,
  leftOfText: true,
  timeAtTop: true,
  timeAboveName: true,
  nameAboveAvatar: true,
  avatarAtFoot: true,
};

/**
 * A root's or reply's own text and 落款 (`row` an entry or a reply): the
 * text's first part, and the signature's geometry against the text.
 */
const signatureLayout = (row: Locator, first: string) =>
  row.evaluate((node, firstPart) => {
    const body = node.querySelector(
      ":scope > div:has(> [data-colophon-text])",
    )!;
    const box = (selector: string) =>
      body.querySelector(`:scope > ${selector}`)!.getBoundingClientRect();
    const inSignature = (selector: string) =>
      body
        .querySelector(`:scope > [data-colophon-signature] ${selector}`)!
        .getBoundingClientRect();
    const text = box("[data-colophon-text]");
    const signature = box("[data-colophon-signature]");
    const time = inSignature("time");
    const name = inSignature("[data-colophon-name]");
    // The name's own foot: its end padding (room for WebKit's ellipsis)
    // hangs past it.
    const nameFoot =
      name.bottom -
      Number.parseFloat(
        getComputedStyle(
          body.querySelector(
            ":scope > [data-colophon-signature] [data-colophon-name]",
          )!,
        ).paddingBottom,
      );
    const avatar = inSignature("[data-colophon-author]");
    return {
      startsWithFirst:
        body
          .querySelector(":scope > [data-colophon-text]")!
          .firstElementChild?.matches(firstPart) === true,
      leftOfText: signature.right <= text.left + 1,
      timeAtTop: Math.abs(time.top - text.top) <= 8,
      timeAboveName: time.bottom < name.top,
      nameAboveAvatar: nameFoot <= avatar.top + 1,
      avatarAtFoot: Math.abs(avatar.bottom - signature.bottom) <= 1,
    };
  }, first);

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
  // 落款: the text starts with its words (a reply's with 「回复 X：」); the
  // signature column on its left holds the time at the top, the nickname
  // above the avatar at the foot. Replies, with the least room, too.
  for (const [selector, first] of [
    ["[data-colophon-entry]", "[data-colophon-words]"],
    ['[data-comment-reply="reply-1"]', "[data-colophon-reply-lead]"],
  ] as const)
    expect(
      await signatureLayout(feed.post.locator(selector).first(), first),
    ).toEqual(SIGNED_AT_LEFT);
  // A guest reads and is invited to sign in to write, in the input column.
  await expect(
    feed.post.locator("[data-colophon-input] [data-colophon-sign-in]"),
  ).toHaveText("登录后题跋");
  await expect(colophon.locator("[data-colophon-head]")).toHaveText(
    /^题跋\s*\d+\s*则$/u,
  );
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.context?.close();
});

/** Opens the feed with latest-1 lengthened to `length` characters. */
const openWithLong = (
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
  length: number,
) =>
  openPhoneFeed(browser, page, testInfo, 0, {
    adjust: (answer) => {
      const long = answer.items.find((item) => item.id === "latest-1");
      if (long !== undefined)
        long.text = `latest-1：${passage.repeat(5)}`.slice(0, length);
    },
  });

/** latest-1 brought to the right gutter, read from its start. */
const readLongFromStart = async (feed: PhoneFeed) => {
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.strip.evaluate((strip) => {
    const node = strip.querySelector<HTMLElement>(
      '[data-colophon-entry][data-comment-id="latest-1"]',
    )!;
    strip.scrollBy({
      left:
        node.getBoundingClientRect().right -
        (strip.getBoundingClientRect().right - 24),
      behavior: "instant",
    });
  });
  await feed.page.waitForTimeout(600);
  const entry = feed.post.locator(
    '[data-colophon-entry][data-comment-id="latest-1"]',
  );
  const fold = entry.locator(":scope > div > [data-colophon-fold]");
  await expect(fold).toHaveText("全文");
  return { entry, fold };
};

/** latest-1's edges against the stage and the input column. */
const longEdges = (entry: Locator) =>
  entry.evaluate((node) => {
    const post = node.closest("[data-feed-post]")!;
    const strip = post
      .querySelector("[data-feed-stage]")!
      .getBoundingClientRect();
    const column = post
      .querySelector("[data-colophon-input]")!
      .getBoundingClientRect();
    const part = (selector: string) =>
      node.querySelector(`:scope > div > ${selector}`)!.getBoundingClientRect();
    return {
      entryRight: Math.round(node.getBoundingClientRect().right),
      textLeft: Math.round(part("[data-colophon-text]").left),
      signatureLeft: Math.round(part("[data-colophon-signature]").left),
      signatureRight: Math.round(part("[data-colophon-signature]").right),
      columnRight: Math.round(column.right),
      stripRight: Math.round(strip.right),
    };
  });

/** Where the strip comes to rest (a passing frame may show anything). */
const restingEdges = async (feed: PhoneFeed, entry: Locator) => {
  let rest = await longEdges(entry);
  for (let check = 0; check < 20; check += 1) {
    await feed.page.waitForTimeout(250);
    const next = await longEdges(entry);
    if (next.entryRight === rest.entryRight) return next;
    rest = next;
  }
  return rest;
};

test("全文 brings the rest of a long colophon and its 落款 into view, clear of the input column", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openWithLong(browser, page, testInfo, 240);
  const { entry, fold } = await readLongFromStart(feed);
  const folded = await longEdges(entry);
  await fold.click();
  await expect(fold).toHaveText("收起");
  const rest = await restingEdges(feed, entry);
  // The 落款 clear of the input column and inside the stage...
  expect(rest.signatureLeft).toBeGreaterThanOrEqual(rest.columnRight);
  expect(rest.signatureRight).toBeLessThanOrEqual(rest.stripRight);
  // ...the fold, where reading goes on, still in view: the start moved on
  // by less than the folded text's width.
  const moved = rest.entryRight - folded.entryRight;
  expect(moved).toBeGreaterThan(0);
  expect(folded.textLeft + moved).toBeLessThan(rest.stripRight);
  await feed.context?.close();
});

test("全文 on a colophon longer than a view keeps its start, and a swipe on stops at its 落款", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openWithLong(browser, page, testInfo, 480);
  const { entry, fold } = await readLongFromStart(feed);
  const folded = await longEdges(entry);
  await fold.click();
  await expect(fold).toHaveText("收起");
  const unfolded = await restingEdges(feed, entry);
  // Unfolded where it was: its start stays at the gutter, its 落款 beyond
  // the stage's left edge.
  expect(Math.abs(unfolded.entryRight - folded.entryRight)).toBeLessThanOrEqual(
    1,
  );
  expect(unfolded.signatureRight).toBeLessThan(unfolded.columnRight);
  await swipeOn(feed);
  const rest = await restingEdges(feed, entry);
  expect(rest.signatureLeft).toBeGreaterThanOrEqual(rest.columnRight);
  expect(rest.signatureRight).toBeLessThanOrEqual(rest.stripRight);
  await feed.context?.close();
});

test("on a narrow phone a long name gives way in the 落款, the time staying at its top", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const author = {
    id: "user-colophon-long",
    displayName: "临池不辍的松风阁主人与他的两方闲章",
    studioName: "松风水月轩主人",
  };
  const old = "2024-12-31T03:00:00.000Z";
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    // A fold phone's cover screen: on the fixture's 4:5 stage the 落款 runs
    // short there, as it does on a square stage from 375 down.
    viewport: { width: 280, height: 653 },
    adjust: (answer) => {
      const hot = answer.hot[0];
      if (hot === undefined) return;
      Object.assign(hot, { author, createdAt: old });
      for (const each of hot.replies)
        Object.assign(each, { author, createdAt: old });
    },
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  for (const [selector, first] of [
    ['[data-colophon-entry][data-comment-id="hot-1"]', "[data-colophon-words]"],
    ['[data-comment-reply="reply-1"]', "[data-colophon-reply-lead]"],
  ] as const)
    expect(await signatureLayout(feed.post.locator(selector), first)).toEqual(
      SIGNED_AT_LEFT,
    );
  // The avatar still names the author in full.
  await expect(
    feed.post.locator('[data-comment-reply="reply-1"] [data-colophon-author]'),
  ).toHaveAttribute("aria-label", `打开${author.displayName}的主页`);
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
  // Never Detail, and nothing takes focus by itself.
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  expect(new URL(feed.page.url()).hash).toBe("");
  await expect(feed.page.locator("textarea:focus")).toHaveCount(0);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await feed.context?.close();
});

// Writing a colophon: the vertical input pinned at the stage's left edge.

const inputOf = (feed: PhoneFeed) => feed.post.locator("[data-colophon-input]");
const boxOf = (feed: PhoneFeed) =>
  feed.post.locator("[data-colophon-input] textarea");
const sendOf = (feed: PhoneFeed) =>
  feed.post.locator("[data-colophon-input-send]");
const noticeOf = (feed: PhoneFeed) =>
  feed.post.locator("[data-colophon-input] [data-colophon-notice]");

/** Focuses the input, as the reader's tap on it does. */
const focusInput = async (feed: PhoneFeed) => {
  await boxOf(feed).focus();
  await expect(boxOf(feed)).toBeFocused();
};

/** A tap on 发送, as the reader's own gesture inside the Home pager. */
const tapSend = (feed: PhoneFeed) =>
  sendOf(feed).evaluate((node) => (node as HTMLElement).click());

const stripOffset = (feed: PhoneFeed) =>
  feed.strip.evaluate((node) => Math.abs(node.scrollLeft));

/** No writing UI anywhere but the vertical column. */
const expectNoHorizontalComposer = async (feed: PhoneFeed) => {
  for (const selector of [
    "[data-colophon-composer]",
    "[data-colophon-composer-outlet]",
    "[data-colophon-invite]",
    "[data-colophon-draft]",
    "[data-colophon-write]",
  ])
    await expect(feed.page.locator(selector)).toHaveCount(0);
  // Every text field in the post writes vertically.
  const modes = await feed.post
    .locator("textarea, input[type='text']")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).writingMode),
    );
  for (const mode of modes) expect(mode).toBe("vertical-rl");
};

test("entering the colophons, a guest finds 登录后题跋 in the column at the stage's left", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo);
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  const column = inputOf(feed);
  await expect(column).toHaveAttribute("data-colophon-input", "guest");
  const signIn = column.locator("[data-colophon-sign-in]");
  await expect(signIn).toHaveText("登录后题跋");
  await expect(signIn).toHaveAttribute("href", /.+/u);
  await expect(signIn).toHaveCSS("writing-mode", "vertical-rl");
  // Whole, at the stage's left. (Measured: WebKit's IntersectionObserver
  // misses the sticky offset of the column's anchor in the strip.)
  const placed = await feed.post.evaluate((post) => {
    const stage = post
      .querySelector("[data-feed-stage-frame]")!
      .getBoundingClientRect();
    const link = post
      .querySelector("[data-colophon-sign-in]")!
      .getBoundingClientRect();
    return {
      inside:
        link.left >= stage.left - 1 &&
        link.right <= stage.left + 56 &&
        link.top >= stage.top - 1 &&
        link.bottom <= Math.min(stage.bottom, window.innerHeight) + 1,
      hit:
        document
          .elementFromPoint(
            (link.left + link.right) / 2,
            (link.top + link.bottom) / 2,
          )
          ?.closest("[data-colophon-sign-in]") != null,
    };
  });
  expect(placed).toEqual({ inside: true, hit: true });
  await expect(boxOf(feed)).toHaveCount(0);
  await expectFirstColophonInView(feed);
  await expectNoHorizontalComposer(feed);
  await expect(feed.home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(feed.shell).toHaveAttribute("data-detail-open", "false");
  await feed.context?.close();
});

test("entering the colophons shows the vertical input pinned at the stage's left, and nothing horizontal", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await feed.page.waitForTimeout(800);
  expect(feed.discussionReads).toHaveLength(0);
  // On the images the column is not there to see or reach.
  await expect(inputOf(feed)).toBeHidden();
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  const column = inputOf(feed);
  await expect(column).toBeVisible();
  await expect(column).toHaveAttribute("data-colophon-input", "write");
  const box = boxOf(feed);
  await expect(box).toHaveAttribute("placeholder", "写题跋…");
  await expect(box).toHaveCSS("writing-mode", "vertical-rl");
  await expect(sendOf(feed)).toHaveText("发送");
  await expect(sendOf(feed)).toBeDisabled();
  await expect(sendOf(feed)).toHaveCSS("writing-mode", "vertical-rl");
  const geometry = await feed.post.evaluate((post) => {
    const frame = post
      .querySelector("[data-feed-stage-frame]")!
      .getBoundingClientRect();
    const input = post
      .querySelector("[data-colophon-input]")!
      .getBoundingClientRect();
    const list = post.querySelector("[data-colophon-list]")!;
    return {
      frame: [frame.left, frame.top, frame.bottom],
      input: [input.left, input.top, input.bottom, input.width],
      inStrip:
        post
          .querySelector("[data-colophon-input]")!
          .closest("[data-feed-stage]") !== null,
      // The column leaves the strip's own pans alone: nothing marks it
      // apart from the strip, so the pager keeps every colophon pannable
      // both ways.
      marked:
        post.querySelector("[data-colophon-input] [data-local-horizontal]") !==
          null ||
        post
          .querySelector("[data-colophon-input]")!
          .hasAttribute("data-local-horizontal"),
      listTouch: getComputedStyle(list).touchAction,
    };
  });
  // At the frame's left edge, its full height, narrow, held in the strip
  // (sticky), so a swipe that starts on it moves the strip.
  expect(Math.abs(geometry.input[0]! - geometry.frame[0]!)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(geometry.input[1]! - geometry.frame[1]!)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(geometry.input[2]! - geometry.frame[2]!)).toBeLessThanOrEqual(
    1,
  );
  expect(geometry.input[3]!).toBeLessThanOrEqual(56);
  expect(geometry.inStrip).toBe(true);
  expect(geometry.marked).toBe(false);
  expect(geometry.listTouch).not.toMatch(/^pan-y/u);
  await expect(feed.post.locator("[data-colophon-head]")).toHaveText(
    /^题跋\s*\d+\s*则$/u,
  );
  await expectFirstColophonInView(feed);
  // Held at the left edge while the strip moves on through the colophons.
  await feed.strip.evaluate((node) =>
    node.scrollBy({ left: -node.clientWidth, behavior: "instant" }),
  );
  await feed.page.waitForTimeout(400);
  const moved = await feed.post.evaluate((post) => [
    post.querySelector("[data-feed-stage-frame]")!.getBoundingClientRect().left,
    post.querySelector("[data-colophon-input]")!.getBoundingClientRect().left,
  ]);
  expect(Math.abs(moved[1]! - moved[0]!)).toBeLessThanOrEqual(1);
  await expectNoHorizontalComposer(feed);
  await expect(box).not.toBeFocused();
  expect(new URL(feed.page.url()).hash).toBe("");
  await feed.context?.close();
});

test("typing writes vertically in the input, which widens over the colophons while the strip stays still", async ({
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
  await focusInput(feed);
  const box = boxOf(feed);
  const draft = "题跋测试十月九日";
  await feed.page.keyboard.type(draft);
  await expect(box).toHaveValue(draft);
  await expect(box).toHaveCSS("writing-mode", "vertical-rl");
  await expect(sendOf(feed)).toBeEnabled();
  // Vertical: the second character sits below the first, in one column.
  const flow = await box.evaluate((node) => {
    const element = node as HTMLTextAreaElement;
    return {
      width: element.offsetWidth,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(flow.scrollHeight).toBeLessThanOrEqual(flow.clientHeight + 1);
  expect(flow.scrollWidth).toBeLessThanOrEqual(flow.width + 1);

  // The column widens with the text, up to 60% of the stage, and the newest
  // (left-most) column stays in view.
  await feed.page.keyboard.insertText("长".repeat(120));
  await feed.page.waitForTimeout(100);
  const grown = await feed.post.evaluate((post) => {
    const element = post.querySelector<HTMLTextAreaElement>(
      "[data-colophon-input] textarea",
    )!;
    return {
      width: element.offsetWidth,
      overflow: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });
  expect(grown.width).toBeGreaterThan(flow.width);
  await feed.page.keyboard.insertText("长".repeat(400));
  await feed.page.waitForTimeout(100);
  const capped = await feed.post.evaluate((post) => {
    const element = post.querySelector<HTMLTextAreaElement>(
      "[data-colophon-input] textarea",
    )!;
    const stage = post.querySelector("[data-feed-stage-frame]")!;
    return {
      width: element.offsetWidth,
      stage: stage.clientWidth,
      overflow: element.scrollWidth - element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });
  expect(capped.width).toBeLessThanOrEqual(capped.stage * 0.6 + 1);
  expect(capped.width).toBeGreaterThan(capped.stage * 0.4);
  expect(capped.overflow).toBeGreaterThan(0);
  // vertical-rl scrolls to negative offsets: the end is the most negative.
  expect(capped.scrollLeft).toBeLessThanOrEqual(-capped.overflow + 2);
  if (testInfo.project.name === "desktop-chromium") {
    await feed.page.evaluate(() =>
      (window as unknown as { __stopLongTasks: () => void }).__stopLongTasks(),
    );
    expect(await longTasks).toBeLessThanOrEqual(50);
  }
  // The strip never moved and the colophons never changed.
  expect(Math.abs((await stripOffset(feed)) - before)).toBeLessThanOrEqual(1);
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  expect(
    await feed.page.evaluate(
      () =>
        (window as unknown as { __colophonMutations: number })
          .__colophonMutations,
    ),
  ).toBe(0);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await expectNoHorizontalComposer(feed);
  await feed.context?.close();
});

test("with the keyboard up, the column ends above it and the caret's column stays in view", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  // The stage low on the screen, under more of the feed.
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
    const stage = post.querySelector("[data-feed-stage-frame]")!;
    scroller!.scrollTop += stage.getBoundingClientRect().top - 260;
  });
  await feed.page.waitForTimeout(300);
  const before = await stripOffset(feed);
  await focusInput(feed);
  // Focusing brings the stage's top up under the header.
  const top = await feed.post.evaluate((post) => {
    let scroller = post.parentElement;
    while (
      scroller !== null &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 2 &&
        /auto|scroll/u.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    return {
      stage: post
        .querySelector("[data-feed-stage-frame]")!
        .getBoundingClientRect().top,
      scroller: scroller!.getBoundingClientRect().top,
    };
  });
  expect(Math.abs(top.stage - top.scroller)).toBeLessThanOrEqual(2);
  // The keyboard, as iOS reports it: the visual viewport loses its foot.
  const visible = 380;
  await feed.page.evaluate((height) => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => height,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, visible);
  await feed.page.keyboard.type("键盘起");
  await feed.page.keyboard.insertText("长".repeat(400));
  const measure = () =>
    feed.post.evaluate((post) => {
      const column = post
        .querySelector("[data-colophon-input]")!
        .getBoundingClientRect();
      const send = post
        .querySelector("[data-colophon-input-send]")!
        .getBoundingClientRect();
      const dockNode = document.querySelector("[data-primary-navigation-dock]");
      const box = post.querySelector<HTMLTextAreaElement>(
        "[data-colophon-input] textarea",
      )!;
      return {
        columnBottom: column.bottom,
        columnHeight: column.height,
        sendBottom: send.bottom,
        dockShown:
          dockNode !== null &&
          getComputedStyle(dockNode).visibility !== "hidden",
        atEnd: box.scrollLeft <= -(box.scrollWidth - box.clientWidth) + 2,
      };
    });
  // The dock and its action make way while the input is written in: the
  // column runs down to the keyboard, with nothing over its foot.
  await expect
    .poll(async () => {
      const now = await measure();
      return Math.abs(now.columnBottom - visible) <= 1;
    })
    .toBe(true);
  const fitted = await measure();
  expect(fitted.dockShown).toBe(false);
  expect(fitted.sendBottom).toBeLessThanOrEqual(visible + 1);
  expect(fitted.columnHeight).toBeGreaterThanOrEqual(160);
  expect(fitted.atEnd).toBe(true);
  // An edit near the start brings the caret's column back in.
  await boxOf(feed).evaluate((node) =>
    (node as HTMLTextAreaElement).setSelectionRange(2, 2),
  );
  await feed.page.keyboard.insertText("插");
  await feed.page.waitForTimeout(100);
  const caret = await boxOf(feed).evaluate((node) => {
    const element = node as HTMLTextAreaElement;
    return { scrollLeft: element.scrollLeft, width: element.clientWidth };
  });
  // Near the start (the right), within one view of it.
  expect(-caret.scrollLeft).toBeLessThan(caret.width);
  await expect(boxOf(feed)).toHaveValue(/^键盘插起/u);
  expect(Math.abs((await stripOffset(feed)) - before)).toBeLessThanOrEqual(1);
  // Left, the dock comes back.
  await boxOf(feed).evaluate((node) => (node as HTMLElement).blur());
  await expect
    .poll(() =>
      feed.page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector("[data-primary-navigation-dock]")!,
          ).visibility,
      ),
    )
    .toBe("visible");
  await feed.context?.close();
});

test("回复 leads the input with 「回复 X：」, focused, and sends a reply", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const submit = submitStub();
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
    submit,
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
  // The toolbar is never left under the input column: 回复 takes a tap.
  await expect
    .poll(() =>
      root.locator("[data-colophon-reply]").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && node.contains(hit);
      }),
    )
    .toBe(true);
  await root
    .locator("[data-colophon-reply]")
    .evaluate((node) => (node as HTMLElement).click());
  const lead = feed.post.locator("[data-colophon-input-reply]");
  await expect(lead).toContainText("回复 读者3：");
  await expect(lead).toHaveCSS("writing-mode", "vertical-rl");
  // The lead is the text's right-most column, beside it, not above it: the
  // text keeps the column's height.
  const [leadBox, textBox] = await Promise.all([
    lead.boundingBox(),
    boxOf(feed).boundingBox(),
  ]);
  expect(leadBox).not.toBeNull();
  expect(textBox).not.toBeNull();
  expect(leadBox!.x).toBeGreaterThanOrEqual(textBox!.x + textBox!.width - 1);
  expect(Math.abs(leadBox!.y - textBox!.y)).toBeLessThanOrEqual(1);
  await expect(boxOf(feed)).toBeFocused();
  await expect(feed.post.locator("[data-colophon-actions]")).toHaveCount(0);
  // × drops the reply target and keeps the text.
  await feed.page.keyboard.type("先写");
  await feed.post
    .locator("[data-colophon-input-unreply]")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(lead).toHaveCount(0);
  await expect(boxOf(feed)).toHaveValue("先写");
  await boxOf(feed).fill("");
  // Aimed again, and sent as a reply.
  await root
    .locator("[data-colophon-text]")
    .first()
    .evaluate((node) => (node as HTMLElement).click());
  await root
    .locator("[data-colophon-reply]")
    .evaluate((node) => (node as HTMLElement).click());
  await feed.page.keyboard.type("同感，碑阴尤佳");
  await tapSend(feed);
  await expect(noticeOf(feed)).toHaveText("已发送");
  expect(submit.bodies).toHaveLength(1);
  expect(submit.bodies[0]).toMatchObject({ text: "同感，碑阴尤佳" });
  await expect(boxOf(feed)).toHaveValue("");
  await expect(lead).toHaveCount(0);
  await feed.context?.close();
});

test("sending: 发送中, then the new colophon is marked in 最新 and the input empties", async ({
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
  await focusInput(feed);
  await feed.page.keyboard.type("新题一则");
  await tapSend(feed);
  await expect(sendOf(feed)).toHaveText("发送中");
  await expect(sendOf(feed)).toBeDisabled();
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
  await expect(noticeOf(feed)).toHaveText("已发送");
  await expect(noticeOf(feed)).toHaveCSS("writing-mode", "vertical-rl");
  await expect(boxOf(feed)).toHaveValue("");
  await expect(boxOf(feed)).not.toBeFocused();
  expect(submit.bodies).toEqual([{ text: "新题一则", mentions: [] }]);
  await expectNoHorizontalComposer(feed);
  await feed.context?.close();
});

test("awaiting approval nothing is inserted; a failure keeps the text and says so", async ({
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
  await feed.page.waitForTimeout(400);
  const before = await stripOffset(feed);
  await focusInput(feed);
  await feed.page.keyboard.type("待审之题");
  await tapSend(feed);
  await expect(noticeOf(feed)).toHaveText("已发送");
  await expect(boxOf(feed)).toHaveValue("");
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.page.waitForTimeout(400);
  expect(Math.abs((await stripOffset(feed)) - before)).toBeLessThanOrEqual(1);
  await expect(feed.post).not.toContainText(/审核|待发布|等待/u);

  submit.mode = "fail";
  await focusInput(feed);
  await feed.page.keyboard.type("发不出的题");
  await tapSend(feed);
  await expect(noticeOf(feed)).not.toHaveText(/^(已发送)?$/u);
  await expect(boxOf(feed)).toHaveValue("发不出的题");
  await expect(sendOf(feed)).toBeEnabled();
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await feed.context?.close();
});

test("the draft stays while the reader goes back to the images and returns", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const feed = await openPhoneFeed(browser, page, testInfo, 0, {
    signedIn: true,
  });
  await enterColophons(feed);
  await expect(feed.post.locator("[data-colophon-entry]")).toHaveCount(12);
  await focusInput(feed);
  await feed.page.keyboard.type("未竟之题");
  await feed.post.locator("[data-feed-post-dot]").first().click();
  await expect(feed.strip).toHaveAttribute("data-feed-stage-region", "media");
  // Hidden on the images, and it let go of focus (and the keyboard).
  await expect(inputOf(feed)).toBeHidden();
  await expect(boxOf(feed)).not.toBeFocused();
  await feed.post.locator("[data-feed-post-dot-comments]").click();
  await expect(feed.strip).toHaveAttribute(
    "data-feed-stage-region",
    "comments",
  );
  await expect(inputOf(feed)).toBeVisible();
  await expect(boxOf(feed)).toHaveValue("未竟之题");
  await feed.context?.close();
});

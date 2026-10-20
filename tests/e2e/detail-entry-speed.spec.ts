import { devices, expect, test } from "@playwright/test";
import sharp from "sharp";
import type {
  Browser,
  CDPSession,
  Locator,
  Page,
  Request,
  TestInfo,
} from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

/** Missing controls must fail finitely: global action and test timeouts are 0. */
const ACTION_TIMEOUT = 10_000;
/**
 * A pointer tap that opened Detail ignores further pointer clicks for 500 ms
 * (feed-post-click-guard); the next deliberate tap waits past it.
 */
const CLICK_GUARD_MS = 600;

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

/**
 * detail-entry-speed-v1 (#310): a work's Detail opens at once from the work
 * record this account already received and its own read confirms it in
 * place; body text opens Detail in the phone single-column post. Community
 * requests are page routes with synthetic works; each work read can be held
 * to observe the seeded frame. Browser emulation, not physical-device QA.
 */
const viewer = {
  id: `user-${"d".repeat(32)}`,
  handle: "synthetic-detail-speed",
  displayName: "详情速读者",
};
const author = {
  id: `user-${"e".repeat(32)}`,
  handle: "synthetic-detail-author",
  displayName: "详情速写者",
};
type Person = typeof viewer;

const imageId = `user-media-${"c".repeat(32)}`;
const IMAGE = {
  id: imageId,
  src: `/api/community/media/${imageId}`,
  width: 900,
  height: 1200,
};

// No digits or curly quotes: vertical Detail text keeps them as written.
const passage = "笔势开张而结体端严，碑阴题名尤可玩味。";

interface Seed {
  readonly id: string;
  readonly title: string;
  /** Longer than a card's 160-character excerpt where it matters. */
  readonly text: string;
  readonly owner: Person;
  readonly image: boolean;
}
const workId = (digit: string) => `work-${digit.repeat(32)}`;
/** The viewer's own work whose body overflows three lines, with an image. */
const LONG: Seed = {
  id: workId("1"),
  title: "长正文测试作品",
  text: `${passage.repeat(10)}全文至此。`,
  owner: viewer,
  image: true,
};
const REVISED_TEXT = `${passage.repeat(10)}修订之后，全文至此。`;
/** The viewer's own text-only work whose body fits. */
const SHORT: Seed = {
  id: workId("2"),
  title: "短正文测试作品",
  text: "一行短正文。",
  owner: viewer,
  image: false,
};
/** The viewer's own untitled work: its body is its only route to Detail. */
const UNTITLED: Seed = {
  id: workId("3"),
  title: "",
  text: "无题之作，只有正文一段，点正文即入详情。",
  owner: viewer,
  image: false,
};
/** Another author's work on Home, listed only as a card with an excerpt. */
const HOME: Seed = {
  id: workId("4"),
  title: "首页正文测试作品",
  text: `${"首页正文一段，读过之后详情即开。".repeat(12)}首页全文至此。`,
  owner: author,
  image: false,
};
const OWN_WORKS = [LONG, SHORT, UNTITLED] as const;

const SKELETON = '[aria-label="正在加载资料"]';

/** The community the page talks to, and what it asked of it. */
interface Community {
  /** Every `GET works/<id>`, in order, by work id. */
  readonly reads: string[];
  /**
   * The `GET works/<id>` the page abandoned before an answer, by work id. The
   * formal web is a Development build, where React StrictMode may run a
   * Detail's read effect twice and abort the first read.
   */
  readonly abandoned: string[];
  /** Reads of this work the page kept: sent and not abandoned. */
  kept(id: string): number;
  /** Every community command (a request other than GET), as "METHOD path". */
  readonly commands: string[];
  /** Holds the answers to `GET works/<id>` until the returned release. */
  hold(id: string): () => void;
  /** The work's text as later reads answer it. */
  revise(id: string, text: string): void;
  /** The work is gone: later reads answer 404 and lists omit it. */
  remove(id: string): void;
  releaseAll(): void;
}

async function serveCommunity(page: Page): Promise<Community> {
  // Discovery precedes startup; load the package schema after fixtures are ready.
  const contracts = await import("@moya/contracts/schemas");
  const image = await sharp({
    create: {
      width: IMAGE.width,
      height: IMAGE.height,
      channels: 3,
      background: { r: 92, g: 84, b: 76 },
    },
  })
    .png()
    .toBuffer();
  const record = (seed: Seed, text = seed.text) =>
    contracts.workSchema.parse({
      id: seed.id,
      authorId: seed.owner.id,
      authorName: seed.owner.displayName,
      title: seed.title,
      text,
      media: seed.image ? [IMAGE] : [],
      firstPublishedAt: "2026-10-10T00:00:00.000Z",
      version: 1,
      canEdit: seed.owner.id === viewer.id,
      available: true,
      // The author's own view says who can see the work now.
      ...(seed.owner.id === viewer.id
        ? { visibility: "public", publiclyVisible: true }
        : {}),
    });
  const current = new Map(
    [...OWN_WORKS, HOME].map((seed) => [seed.id, record(seed)] as const),
  );
  const ownerOf = new Map(
    [...OWN_WORKS, HOME].map((seed) => [seed.id, seed.owner.id] as const),
  );
  const profile = (person: Person) =>
    contracts.authorProfileSchema.parse({
      ...person,
      bio: "",
      avatar: null,
      background: null,
      isOwner: person.id === viewer.id,
      following: false,
      privacy: {
        following: "public",
        followers: "public",
        favorites: "public",
        likes: "public",
      },
      totals: {
        works: person.id === viewer.id ? OWN_WORKS.length : 1,
        following: 0,
        followers: 0,
        favorites: 0,
        likes: 0,
      },
      nextAvatarChangeAt: null,
    });
  const people = new Map(
    [viewer, author].map((person) => [person.id, person] as const),
  );
  const worksOf = (authorId: string) => {
    const items = [...current]
      .filter(([id]) => ownerOf.get(id) === authorId)
      .map(([, work]) => work);
    return contracts.workPageSchema.parse({
      items,
      total: items.length,
      page: 1,
      pageSize: 12,
    });
  };
  const discover = contracts.discoveryPageSchema.parse({
    items: [
      {
        target: { type: "work", id: HOME.id },
        title: HOME.title,
        excerpt: Array.from(HOME.text).slice(0, 160).join(""),
        aliases: [],
        kind: null,
        authorId: author.id,
        firstPublishedAt: "2026-10-10T00:00:00.000Z",
        media: null,
      },
    ],
    sequence: "33333333-3333-4333-8333-333333333333",
    nextAfter: 1,
    hasMore: false,
  });
  const discussion = contracts.discussionPageSchema.parse({
    visibleTotal: 0,
    hot: [],
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 0,
  });
  const state = contracts.contentStateSchema.parse({
    favorite: false,
    liked: false,
    favoriteCount: 0,
    likeCount: 0,
    commentCount: 0,
  });

  const reads: string[] = [];
  const abandoned: string[] = [];
  const commands: string[] = [];
  const gates = new Map<string, { promise: Promise<void>; open(): void }>();
  const workRead = (request: Request) =>
    request.method() === "GET"
      ? /^\/api\/community\/works\/([^/]+)$/u.exec(
          new URL(request.url()).pathname,
        )
      : null;
  page.on("requestfailed", (request) => {
    const work = workRead(request);
    if (work) abandoned.push(decodeURIComponent(work[1]!));
  });

  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== "GET") {
      commands.push(`${method} ${path}`);
      return route.fulfill({ status: 409, json: {} });
    }
    const work = workRead(request);
    if (work) {
      const id = decodeURIComponent(work[1]!);
      reads.push(id);
      const gate = gates.get(id);
      if (gate) await gate.promise;
      const answer = current.get(id);
      try {
        return await (answer
          ? route.fulfill({
              json: answer,
              headers: { "cache-control": "private, no-store" },
            })
          : route.fulfill({
              status: 404,
              json: { error: { code: "NOT_FOUND", message: "not found" } },
            }));
      } catch {
        // A held answer may outlive its page.
        return undefined;
      }
    }
    if (path === IMAGE.src)
      return route.fulfill({ body: image, contentType: "image/png" });
    if (path.startsWith("/api/community/media/"))
      return route.fulfill({ status: 404 });
    if (path === "/api/community/me") return route.fulfill({ json: viewer });
    if (path === "/api/community/access")
      return route.fulfill({ json: { mode: "public", access: "granted" } });
    const authorPath = /^\/api\/community\/authors\/([^/]+)$/u.exec(path);
    const person = authorPath && people.get(decodeURIComponent(authorPath[1]!));
    if (person) return route.fulfill({ json: profile(person) });
    const works = /^\/api\/community\/authors\/([^/]+)\/works$/u.exec(path);
    if (works)
      return route.fulfill({ json: worksOf(decodeURIComponent(works[1]!)) });
    if (path === "/api/community/discover")
      return route.fulfill({ json: discover });
    if (path.startsWith("/api/community/discussion/work/"))
      return route.fulfill({ json: discussion });
    if (/^\/api\/community\/content\/work\/[^/]+\/state$/u.test(path))
      return route.fulfill({ json: state });
    if (path === "/api/community/publishing/drafts")
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12, totalPages: 0 },
      });
    if (path === "/api/community/messages/unread")
      return route.fulfill({ json: { unreadConversations: 0 } });
    if (path === "/api/community/notifications/stream") return route.abort();
    // The anonymous fixture answers the Catalog and the other Home feeds.
    if (
      path === "/api/community/filter-options" ||
      path.startsWith("/api/community/editorial/") ||
      path === "/api/community/threads" ||
      path.startsWith("/api/community/content/catalog/") ||
      path.startsWith("/api/community/discussion/catalog/")
    )
      return route.continue();
    return route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 12 },
    });
  });

  const countOf = (list: readonly string[], id: string) =>
    list.filter((entry) => entry === id).length;
  return {
    reads,
    abandoned,
    kept: (id) => countOf(reads, id) - countOf(abandoned, id),
    commands,
    hold(id) {
      let open = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      const gate = { promise, open };
      gates.set(id, gate);
      return () => {
        if (gates.get(id) === gate) gates.delete(id);
        gate.open();
      };
    },
    revise(id, text) {
      const seed = [...OWN_WORKS, HOME].find((entry) => entry.id === id);
      if (seed === undefined) throw new Error(`Unknown work ${id}`);
      current.set(id, record(seed, text));
    },
    remove(id) {
      current.delete(id);
    },
    releaseAll() {
      for (const gate of gates.values()) gate.open();
      gates.clear();
    },
  };
}

interface Phone {
  readonly page: Page;
  /** Trusted compositor touch (desktop Chromium only). */
  readonly session: CDPSession | null;
  readonly shell: Locator;
  readonly community: Community;
  close(): Promise<void>;
}

/**
 * The signed-in formal Home on an iPhone. On desktop Chromium the phone is an
 * emulated context so the compositor accepts trusted touch input over CDP;
 * the mobile WebKit project uses its own page.
 */
async function openPhone(
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
): Promise<Phone> {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  let target = page;
  let session: CDPSession | null = null;
  let closeContext = async () => {};
  if (testInfo.project.name === "desktop-chromium") {
    const context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
    });
    target = await context.newPage();
    session = await context.newCDPSession(target);
    closeContext = () => context.close();
  }
  const community = await serveCommunity(target);
  const close = async () => {
    community.releaseAll();
    await closeContext();
  };
  try {
    // A signed-in browser carries its session cookie (pc-browse-only-v1).
    await addSessionCookie(target.context(), baseURL);
    const response = await target.goto("/", { timeout: 30_000 });
    expect(response?.status()).toBe(200);
    await expect(target.locator("[data-product-boot]")).toHaveCount(0);
    const shell = target.locator("[data-product-shell]");
    await expect(shell).toHaveAttribute("data-platform", "phone");
    // Phone opens on the single-column post feed.
    await expect(shell).toHaveAttribute("data-feed-layout", "single");
    return { page: target, session, shell, community, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const center = async (locator: Locator) => {
  const box = await locator.boundingBox({ timeout: ACTION_TIMEOUT });
  if (box === null) throw new Error("Missing geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
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

/** A finger tap on a visible control: trusted touch where available. */
const tap = async (phone: Phone, target: Locator) => {
  await expect(target).toBeVisible();
  if (phone.session !== null)
    await trustedTap(phone.session, await center(target));
  else await target.tap({ timeout: ACTION_TIMEOUT });
};

/**
 * Centres a control in its scroller, clear of the floating dock and the
 * sticky headers, and waits until it is the element at its own centre.
 */
const bringIntoView = async (page: Page, target: Locator) => {
  await expect(target).toBeVisible();
  await target.evaluate(
    (node) => node.scrollIntoView({ block: "center" }),
    undefined,
    { timeout: ACTION_TIMEOUT },
  );
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      target.evaluate(
        (node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return hit !== null && (hit === node || node.contains(hit));
        },
        undefined,
        { timeout: ACTION_TIMEOUT },
      ),
    )
    .toBe(true);
  await frames(page);
};

const scrollTopOf = (scroller: Locator) =>
  scroller.evaluate((node) => node.scrollTop, undefined, {
    timeout: ACTION_TIMEOUT,
  });

/** Opens 我 from the dock and waits for its Works tab posts. */
async function openOwnWorks(phone: Phone) {
  const user = phone.page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true });
  await expect(user).toBeVisible();
  await user.click({ timeout: ACTION_TIMEOUT });
  await expect(
    phone.page.getByRole("heading", { name: viewer.displayName, exact: true }),
  ).toBeVisible();
  await expect(
    phone.page.getByRole("tab", { name: "作品", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  for (const seed of OWN_WORKS)
    await expect(ownPost(phone.page, seed)).toHaveCount(1);
  // Primary navigation restores its saved scroll in two animation frames.
  await frames(phone.page);
}

const ownPost = (page: Page, seed: Seed) =>
  page.locator(
    `[data-author-panel="works"] [data-feed-post][data-content-id="${seed.id}"]`,
  );
const homePost = (page: Page) =>
  page.locator(
    `[data-home-feed-panel="discover"] [data-feed-post][data-content-id="${HOME.id}"]`,
  );
const detailOf = (page: Page) => page.locator("[data-detail-state]");

/** The open Detail shows this work (its title, or the untitled heading, and its text). */
async function expectDetail(phone: Phone, seed: Seed, text = seed.text) {
  await expect(phone.shell).toHaveAttribute("data-detail-open", "true");
  const detail = detailOf(phone.page);
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  if (seed.title === "")
    await expect(detail.locator("[data-detail-untitled]")).toHaveCount(1);
  else
    await expect(detail.locator("[data-detail-title]")).toHaveText(seed.title);
  await expect(
    detail.locator('[data-detail-section="description"]'),
  ).toHaveText(text);
  return detail;
}

/** Back from Detail, once the tap's click guard has run out. */
async function leaveDetail(phone: Phone) {
  await phone.page.waitForTimeout(CLICK_GUARD_MS);
  await phone.page.goBack({ timeout: ACTION_TIMEOUT });
  await expect(phone.shell).toHaveAttribute("data-detail-open", "false");
}

interface SkeletonProbe {
  __detailSkeletonSeen?: boolean;
  __detailSkeletonProbe?: MutationObserver;
  __detailSkeletonScan?: (records: MutationRecord[]) => void;
}

/**
 * Records whether the loading skeleton is ever inserted from now on, however
 * briefly: a node added and removed again within one task still shows in
 * the records' added or removed nodes.
 */
const watchSkeleton = (page: Page) =>
  page.evaluate((selector) => {
    const probe = window as unknown as SkeletonProbe;
    probe.__detailSkeletonProbe?.disconnect();
    const holds = (node: Node) =>
      node instanceof Element &&
      (node.matches(selector) || node.querySelector(selector) !== null);
    probe.__detailSkeletonSeen = document.querySelector(selector) !== null;
    probe.__detailSkeletonScan = (records) => {
      for (const record of records)
        if (
          (record.type === "attributes" && holds(record.target)) ||
          Array.from(record.addedNodes).some(holds) ||
          Array.from(record.removedNodes).some(holds)
        )
          probe.__detailSkeletonSeen = true;
    };
    const observer = new MutationObserver((records) =>
      probe.__detailSkeletonScan?.(records),
    );
    observer.observe(document.documentElement, {
      attributeFilter: ["aria-label"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    probe.__detailSkeletonProbe = observer;
  }, SKELETON);

const skeletonSeen = (page: Page) =>
  page.evaluate(() => {
    const probe = window as unknown as SkeletonProbe;
    probe.__detailSkeletonScan?.(
      probe.__detailSkeletonProbe?.takeRecords() ?? [],
    );
    return probe.__detailSkeletonSeen === true;
  });

const skipUnlessPhone = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "The single-column post feed is the phone's.",
  );
const skipUnlessTrustedTouch = (testInfo: TestInfo) =>
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Trusted compositor touch injection uses the Chromium protocol.",
  );

test("我 Works posts show each full body from the list read, with no per-post work read", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    await openOwnWorks(phone);
    for (const seed of OWN_WORKS) {
      const post = ownPost(phone.page, seed);
      const body = post.locator("[data-feed-post-body-state]");
      await bringIntoView(phone.page, body);
      // The full text, not the card's excerpt, from the first render.
      await expect(body).toHaveAttribute("data-feed-post-body-state", "loaded");
      await expect(post.locator("[data-feed-post-body]")).toHaveText(seed.text);
    }
    // The overflowing body offers 展开正文 without waiting for a read.
    await expect(
      ownPost(phone.page, LONG).getByRole("button", { name: "展开正文" }),
    ).toBeVisible();
    await expect(
      ownPost(phone.page, SHORT).getByRole("button", { name: "展开正文" }),
    ).toHaveCount(0);
    await phone.page.waitForTimeout(500);
    // Home's own post read its work before 我 opened; 我 read none.
    const own = new Set<string>(OWN_WORKS.map((seed) => seed.id));
    expect(phone.community.reads.filter((id) => own.has(id))).toEqual([]);
  } finally {
    await phone.close();
  }
});

test("a 我 Works body tap opens a seeded Detail at once that its held read confirms in place", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    await openOwnWorks(phone);
    const post = ownPost(phone.page, LONG);
    const opener = post.locator("[data-feed-post-body-open]");
    await bringIntoView(phone.page, opener);
    await expect(opener).toHaveAttribute("aria-label", "查看详情");
    const feed = phone.page.locator('[data-primary-destination="user"]');
    const feedTop = await scrollTopOf(feed);

    await watchSkeleton(phone.page);
    const release = phone.community.hold(LONG.id);
    await tap(phone, opener);
    // The first frame is the list's work, marked provisional.
    const detail = await expectDetail(phone, LONG);
    await expect(detail).toHaveAttribute("data-detail-provisional", "");
    // Every open still reads the work; this one is held.
    await expect.poll(() => phone.community.kept(LONG.id)).toBe(1);

    // The author's own controls are usable on the seeded frame.
    const management = detail.locator("[data-work-management]");
    const visibility = management.getByRole("switch", { name: "公开" });
    for (const control of [
      management.getByRole("button", { name: "编辑", exact: true }),
      management.getByRole("button", { name: "永久删除", exact: true }),
      visibility,
    ]) {
      await expect(control).toBeVisible();
      await expect(control).not.toHaveAttribute("aria-disabled");
      await expect(control).toBeEnabled();
    }
    await expect(visibility).toHaveAttribute("aria-checked", "true");
    // A public own work carries no audience note.
    await expect(detail.locator("[data-work-notice]")).toHaveCount(0);
    await expect(detail).toHaveAttribute("data-detail-provisional", "");

    // The answer, with changed text, replaces the content in place.
    const layout = await detail
      .locator("[data-detail-calligraphy-layout], [data-detail-paged-layout]")
      .elementHandle({ timeout: ACTION_TIMEOUT });
    if (layout === null) throw new Error("Missing Detail layout");
    const scroller = phone.page.locator("[data-detail-scroll]");
    const detailTop = await scroller.evaluate(
      (node) => {
        node.scrollTop = Math.min(
          80,
          Math.max(0, node.scrollHeight - node.clientHeight),
        );
        return node.scrollTop;
      },
      undefined,
      { timeout: ACTION_TIMEOUT },
    );
    const sent = phone.community.reads.length;
    phone.community.revise(LONG.id, REVISED_TEXT);
    release();
    await expect(
      detail.locator('[data-detail-section="description"]'),
    ).toHaveText(REVISED_TEXT);
    await expect(detail).not.toHaveAttribute("data-detail-provisional");
    await expect(detail).toHaveAttribute("data-detail-state", "loaded");
    expect(
      await phone.page.evaluate(
        (node) =>
          node.isConnected &&
          document.querySelector(
            "[data-detail-calligraphy-layout], [data-detail-paged-layout]",
          ) === node,
        layout,
      ),
    ).toBe(true);
    expect(Math.abs((await scrollTopOf(scroller)) - detailTop)).toBeLessThan(1);
    // From the tap to the confirmation, the skeleton never appeared.
    expect(await skeletonSeen(phone.page)).toBe(false);
    // Confirmed without a remount: nothing was read again.
    expect(phone.community.reads.length).toBe(sent);
    expect(phone.community.kept(LONG.id)).toBe(1);

    // Back restores the feed and focuses the body's opener.
    await leaveDetail(phone);
    await expect(opener).toBeFocused();
    await expect
      .poll(async () => Math.abs((await scrollTopOf(feed)) - feedTop))
      .toBeLessThan(1);
    await expect(post.locator("[data-feed-post-body]")).toHaveText(
      REVISED_TEXT,
    );
  } finally {
    await phone.close();
  }
});

test("the title and an untitled body open Detail; only 展开正文 and 收起正文 change the body, which still opens Detail when expanded", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    await openOwnWorks(phone);
    const long = ownPost(phone.page, LONG);

    // The title of an overflowing body opens Detail; it expands nothing.
    const title = long.getByRole("button", {
      name: `打开${LONG.title}`,
      exact: true,
    });
    await bringIntoView(phone.page, title);
    await expect(long.getByRole("button", { name: "展开正文" })).toBeVisible();
    await expect(title).not.toHaveAttribute("aria-expanded");
    await expect(title).not.toHaveAttribute("aria-controls");
    await tap(phone, title);
    await expectDetail(phone, LONG);
    await leaveDetail(phone);
    await expect(title).toBeFocused();
    await expect(long).not.toHaveAttribute("data-feed-post-expanded");

    // 展开正文 expands in place and never opens Detail.
    const expand = long.getByRole("button", { name: "展开正文" });
    await bringIntoView(phone.page, expand);
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await tap(phone, expand);
    await expect(long).toHaveAttribute("data-feed-post-expanded", "true");
    const collapse = long.getByRole("button", { name: "收起正文" });
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await phone.page.waitForTimeout(CLICK_GUARD_MS);
    await expect(phone.shell).toHaveAttribute("data-detail-open", "false");

    // The expanded body still opens Detail.
    const opener = long.locator("[data-feed-post-body-open]");
    await bringIntoView(phone.page, opener);
    await tap(phone, opener);
    await expectDetail(phone, LONG);
    await leaveDetail(phone);
    await expect(opener).toBeFocused();
    await expect(long).toHaveAttribute("data-feed-post-expanded", "true");

    // 收起正文 collapses in place and never opens Detail.
    await bringIntoView(phone.page, collapse);
    await tap(phone, collapse);
    await expect(long).not.toHaveAttribute("data-feed-post-expanded");
    await expect(
      long.getByRole("button", { name: "展开正文" }),
    ).toHaveAttribute("aria-expanded", "false");
    await phone.page.waitForTimeout(CLICK_GUARD_MS);
    await expect(phone.shell).toHaveAttribute("data-detail-open", "false");

    // An untitled work has no heading; its body is the route to Detail.
    const untitled = ownPost(phone.page, UNTITLED);
    await expect(untitled.locator("[data-feed-post-title]")).toHaveCount(0);
    const untitledOpener = untitled.locator("[data-feed-post-body-open]");
    await bringIntoView(phone.page, untitledOpener);
    await tap(phone, untitledOpener);
    await expectDetail(phone, UNTITLED);
    await leaveDetail(phone);
    await expect(untitledOpener).toBeFocused();
  } finally {
    await phone.close();
  }
});

test("a Home post reads its work once when visible, then opens a seeded Detail", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    const post = homePost(phone.page);
    const opener = post.locator("[data-feed-post-body-open]");
    await bringIntoView(phone.page, opener);
    // The card's excerpt first, then the full text from one work read.
    await expect(post.locator("[data-feed-post-body]")).toHaveText(HOME.text);
    await phone.page.waitForTimeout(500);
    expect(phone.community.reads).toEqual([HOME.id]);
    expect(phone.community.abandoned).toEqual([]);

    await watchSkeleton(phone.page);
    const release = phone.community.hold(HOME.id);
    await tap(phone, opener);
    const detail = await expectDetail(phone, HOME);
    await expect(detail).toHaveAttribute("data-detail-provisional", "");
    // The body's read, then the Detail's own (held).
    await expect.poll(() => phone.community.kept(HOME.id)).toBe(2);
    // Another author's work: no management.
    await expect(detail.locator("[data-work-management]")).toHaveCount(0);
    const sent = phone.community.reads.length;
    release();
    await expect(detail).not.toHaveAttribute("data-detail-provisional");
    await expectDetail(phone, HOME);
    expect(await skeletonSeen(phone.page)).toBe(false);
    expect(phone.community.reads.length).toBe(sent);

    await leaveDetail(phone);
    await expect(opener).toBeFocused();
  } finally {
    await phone.close();
  }
});

test("a seeded Detail whose read answers 404 shows 未找到这项资料, and reopening it passes through loading", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    await openOwnWorks(phone);
    const post = ownPost(phone.page, SHORT);
    const title = post.getByRole("button", {
      name: `打开${SHORT.title}`,
      exact: true,
    });
    await bringIntoView(phone.page, title);

    await watchSkeleton(phone.page);
    let release = phone.community.hold(SHORT.id);
    await tap(phone, title);
    const detail = await expectDetail(phone, SHORT);
    await expect(detail).toHaveAttribute("data-detail-provisional", "");
    await expect.poll(() => phone.community.kept(SHORT.id)).toBe(1);
    phone.community.remove(SHORT.id);
    release();
    await expect(detail).toHaveAttribute("data-detail-state", "not-found");
    await expect(detail.getByText("未找到这项资料")).toBeVisible();
    await expect(detail).not.toHaveAttribute("data-detail-provisional");
    expect(await skeletonSeen(phone.page)).toBe(false);
    // The record is forgotten: the post's body reads once for itself.
    await expect.poll(() => phone.community.kept(SHORT.id)).toBe(2);

    await leaveDetail(phone);
    await expect(post.locator("[data-feed-post-body-state]")).toHaveAttribute(
      "data-feed-post-body-state",
      "error",
    );

    // Forward into the same Detail: nothing seeds it any more.
    await watchSkeleton(phone.page);
    release = phone.community.hold(SHORT.id);
    await phone.page.goForward({ timeout: ACTION_TIMEOUT });
    await expect(phone.shell).toHaveAttribute("data-detail-open", "true");
    await expect(phone.page.locator(SKELETON)).toBeVisible();
    await expect(detail).toHaveAttribute("data-detail-state", "loading");
    expect(await skeletonSeen(phone.page)).toBe(true);
    release();
    await expect(detail).toHaveAttribute("data-detail-state", "not-found");
  } finally {
    await phone.close();
  }
});

test("a horizontal swipe starting on body text pages the Home and profile tabs, not Detail", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    const session = phone.session!;
    const swipeOn = async (opener: Locator) => {
      await bringIntoView(phone.page, opener);
      const { box } = await center(opener);
      await trustedDrag(
        phone.page,
        session,
        { x: box.x + box.width * 0.85, y: box.y + box.height / 2 },
        -box.width * 0.6,
      );
    };

    const home = phone.page.locator("[data-home-surface]");
    const post = homePost(phone.page);
    await expect(post.locator("[data-feed-post-body]")).toHaveText(HOME.text);
    await expect(home).toHaveAttribute("data-active-home-feed", "discover");
    await swipeOn(post.locator("[data-feed-post-body-open]"));
    await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
    await phone.page.waitForTimeout(CLICK_GUARD_MS);
    await expect(phone.shell).toHaveAttribute("data-detail-open", "false");

    await openOwnWorks(phone);
    await swipeOn(
      ownPost(phone.page, LONG).locator("[data-feed-post-body-open]"),
    );
    await expect(
      phone.page.getByRole("tab", { name: "收藏", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await phone.page.waitForTimeout(CLICK_GUARD_MS);
    await expect(phone.shell).toHaveAttribute("data-detail-open", "false");
  } finally {
    await phone.close();
  }
});

test("a double tap on body text opens Detail once, and the second tap reaches nothing under it", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessTrustedTouch(testInfo);
  const phone = await openPhone(browser, page, testInfo);
  try {
    await openOwnWorks(phone);
    const opener = ownPost(phone.page, LONG).locator(
      "[data-feed-post-body-open]",
    );
    await bringIntoView(phone.page, opener);
    const point = await center(opener);
    const entries = await phone.page.evaluate(() => history.length);
    await trustedTap(phone.session!, point);
    await phone.page.waitForTimeout(80);
    await trustedTap(phone.session!, point);
    await expectDetail(phone, LONG);
    // The second tap landed on the Detail now covering the feed.
    expect(
      await phone.page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest("[data-detail-state]") !==
          null,
        { x: point.x, y: point.y },
      ),
    ).toBe(true);
    // Well past the double-tap window: Detail stays, nothing else opened.
    await phone.page.waitForTimeout(CLICK_GUARD_MS);
    // The Viewer's dialog stays closed (it is in the Detail's DOM, shut).
    await expect(phone.page.locator("[data-detail-viewer][open]")).toHaveCount(
      0,
    );
    await expect(phone.shell).toHaveAttribute("data-viewer-open", "false");
    await expect(phone.shell).toHaveAttribute("data-detail-open", "true");
    expect(new URL(phone.page.url()).hash).toBe("#detail");
    expect(await phone.page.evaluate(() => history.length)).toBe(entries + 1);
    expect(
      phone.community.commands.filter((command) => /like/u.test(command)),
    ).toEqual([]);
  } finally {
    await phone.close();
  }
});

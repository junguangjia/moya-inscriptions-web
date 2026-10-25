import { devices, expect, test } from "@playwright/test";
import sharp from "sharp";
import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  TestInfo,
} from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

/** Missing controls must fail finitely: global action and test timeouts are 0. */
const ACTION_TIMEOUT = 10_000;

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

/**
 * #341: the phone feed and the work cards show a work image in the framing
 * its read carries (`feed`, the reader form): a taller image cropped at the
 * chosen region (局部) or kept whole with blank sides (整张), and cropped at
 * the centre without one. The server reads an uncropped image its author
 * never framed as 整张 (r3), and a centred cover as no framing. Community
 * requests are page routes with synthetic works whose images (900 × 1800)
 * are taller than every box they meet. Browser emulation, not
 * physical-device QA.
 */
const viewer = {
  id: `user-${"b".repeat(32)}`,
  handle: "synthetic-framing-reader",
  displayName: "构图读者",
};
const author = {
  id: `user-${"c".repeat(32)}`,
  handle: "synthetic-framing-author",
  displayName: "构图作者",
};
type Person = typeof viewer;

const IMAGE = { width: 900, height: 1800 } as const;
/** A work image at its authorized display path. */
const still = (digit: string) => {
  const id = `media-item-${digit.repeat(32)}`;
  return {
    id,
    src: `/api/community/publishing/media/${id}/display/base`,
    ...IMAGE,
  };
};
const workId = (digit: string) => `work-${digit.repeat(32)}`;

/** 局部 at the top on the cover and its first image, 整张 on its second, nothing on its third. */
const FRAMED = {
  id: workId("1"),
  title: "局部与整张",
  media: { ...still("1"), feed: { fit: "cover", y: 0 } },
  gallery: [
    { ...still("1"), feed: { fit: "cover", y: 0 } },
    { ...still("2"), feed: { fit: "contain" } },
    still("3"),
  ],
} as const;
/** No gallery: its cover is the post's one image, kept whole (an uncropped one's default). */
const WHOLE = {
  id: workId("2"),
  title: "整张作品",
  media: { ...still("4"), feed: { fit: "contain" } },
} as const;
/** No framing read: a centred cover (a cropped image never framed, or 局部 at the centre). */
const PLAIN = {
  id: workId("3"),
  title: "居中作品",
  media: still("5"),
} as const;
const WORKS = [FRAMED, WHOLE, PLAIN] as const;

async function serveCommunity(page: Page): Promise<void> {
  // Discovery precedes startup; load the package schema after fixtures are ready.
  const contracts = await import("@moya/contracts/schemas");
  const image = await sharp({
    create: { ...IMAGE, channels: 3, background: { r: 92, g: 84, b: 76 } },
  })
    .png()
    .toBuffer();
  const sources = new Set(
    WORKS.flatMap((work) => [
      work.media.src,
      ...("gallery" in work ? work.gallery.map((entry) => entry.src) : []),
    ]),
  );
  const discover = contracts.discoveryPageSchema.parse({
    items: WORKS.map((work) => ({
      target: { type: "work", id: work.id },
      title: work.title,
      aliases: [],
      kind: null,
      authorId: author.id,
      firstPublishedAt: "2026-10-20T00:00:00.000Z",
      media: work.media,
      ...("gallery" in work
        ? { gallery: work.gallery, mediaCount: work.gallery.length }
        : {}),
    })),
    sequence: "44444444-4444-4444-8444-444444444444",
    nextAfter: WORKS.length,
    hasMore: false,
  });
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
        works: person.id === viewer.id ? 0 : WORKS.length,
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

  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET")
      return route.fulfill({ status: 409, json: {} });
    if (sources.has(path))
      return route.fulfill({ body: image, contentType: "image/png" });
    if (path === "/api/community/me") return route.fulfill({ json: viewer });
    if (path === "/api/community/access")
      return route.fulfill({ json: { mode: "public", access: "granted" } });
    const authorPath = /^\/api\/community\/authors\/([^/]+)$/u.exec(path);
    const person = authorPath && people.get(decodeURIComponent(authorPath[1]!));
    if (person) return route.fulfill({ json: profile(person) });
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
}

interface Home {
  readonly page: Page;
  /** Home's 发现 panel. */
  readonly feed: Locator;
  close(): Promise<void>;
}

/**
 * The signed-in formal Home in the reader's feed layout. The phone's
 * single-column feed runs on an emulated iPhone context in desktop Chromium
 * and on the mobile WebKit project's own page; two columns are the reader's
 * choice on a phone or tablet and always on a wide screen.
 */
async function openHome(
  browser: Browser,
  page: Page,
  testInfo: TestInfo,
  layout: "single" | "double",
): Promise<Home> {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  let target = page;
  let context: BrowserContext | null = null;
  if (layout === "single" && testInfo.project.name === "desktop-chromium") {
    context = await browser.newContext({ ...devices["iPhone 15"], baseURL });
    target = await context.newPage();
  }
  const close = async () => {
    await context?.close();
  };
  try {
    await target.addInitScript((value) => {
      try {
        window.localStorage.setItem("yoyi.home-feed-layout.v2", value);
      } catch {
        // Storage may be unavailable; the layout then follows the platform.
      }
    }, layout);
    await serveCommunity(target);
    // A signed-in browser carries its session cookie (pc-browse-only-v1).
    await addSessionCookie(target.context(), baseURL);
    const response = await target.goto("/", { timeout: 30_000 });
    expect(response?.status()).toBe(200);
    await expect(target.locator("[data-product-boot]")).toHaveCount(0);
    const shell = target.locator("[data-product-shell]");
    if (layout === "single")
      await expect(shell).toHaveAttribute("data-platform", "phone");
    await expect(shell).toHaveAttribute("data-feed-layout", layout);
    const feed = target.locator('[data-home-feed-panel="discover"]');
    await expect(feed).toBeVisible();
    return { page: target, feed, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The element's background and the colour token, both as the browser computes them. */
const backgroundAndToken = async (locator: Locator, token: string) => {
  await expect(locator).toBeVisible();
  return locator.evaluate(
    (node, name) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor =
        getComputedStyle(node).getPropertyValue(name);
      return {
        background: getComputedStyle(node).backgroundColor,
        token: sample.style.backgroundColor,
      };
    },
    token,
    { timeout: ACTION_TIMEOUT },
  );
};

const skipUnlessPhone = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "The post stage exists only in the phone single-column feed.",
  );

test("the phone feed shows each work image at its author's region, whole, or centred", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessPhone(testInfo);
  const home = await openHome(browser, page, testInfo, "single");
  try {
    const post = (id: string) =>
      home.feed.locator(`[data-feed-post][data-content-id="${id}"]`);
    const framed = post(FRAMED.id);
    await expect(framed).toBeVisible();
    await framed.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
    await expect(framed.locator("[data-feed-stage]")).toHaveAttribute(
      "data-feed-stage-count",
      "3",
    );
    // A first image taller than 4:5 stops the stage there.
    const stage = framed.locator("[data-feed-stage-frame]");
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox({ timeout: ACTION_TIMEOUT });
    if (box === null) throw new Error("Missing stage geometry");
    expect(box.height / box.width).toBeCloseTo(1.25, 1);
    const slide = (index: number) =>
      framed.locator(`[data-feed-slide="${index}"]`);
    const picture = (index: number) =>
      slide(index).locator("[data-feed-slide-image] img");

    // 局部 at the top: cropped from the image's top edge.
    await expect(slide(0)).toHaveAttribute("data-fit", "cover");
    await expect(slide(0)).toHaveAttribute("data-feed-framing", "region");
    await expect(slide(0)).toHaveAttribute("style", /--feed-slide-y:\s*0%/u);
    await expect(picture(0)).toHaveCSS("object-fit", "cover");
    await expect(picture(0)).toHaveCSS("object-position", "50% 0%");
    // 整张: the whole image, its blank sides on the stage's page colour.
    await expect(slide(1)).toHaveAttribute("data-fit", "contain");
    await expect(slide(1)).toHaveAttribute("data-feed-framing", "whole");
    await expect(slide(1)).not.toHaveAttribute("style", /--feed-slide-y/u);
    await expect(picture(1)).toHaveCSS("object-fit", "contain");
    const colours = await backgroundAndToken(
      stage,
      "--yoyi-color-background-page",
    );
    expect(colours.token).not.toBe("");
    expect(colours.background).toBe(colours.token);
    // No framing read: cropped at the centre.
    await expect(slide(2)).toHaveAttribute("data-fit", "cover");
    await expect(slide(2)).not.toHaveAttribute("data-feed-framing");
    await expect(picture(2)).toHaveCSS("object-position", "50% 50%");

    // Without a gallery the cover is the post's image, in its framing.
    const whole = post(WHOLE.id).locator('[data-feed-slide="0"]');
    await expect(whole).toHaveAttribute("data-fit", "contain");
    await expect(whole).toHaveAttribute("data-feed-framing", "whole");
    const plain = post(PLAIN.id).locator('[data-feed-slide="0"]');
    await expect(plain).toHaveAttribute("data-fit", "cover");
    await expect(plain).not.toHaveAttribute("data-feed-framing");
  } finally {
    await home.close();
  }
});

test("a two-column work card follows its cover's framing", async ({
  browser,
  page,
}, testInfo) => {
  const home = await openHome(browser, page, testInfo, "double");
  try {
    const media = (id: string) =>
      home.feed.locator(
        `article[data-content-id="${id}"] [data-catalog-media-state="valid"]`,
      );

    // 局部 at the top of the cover, in the card's own box.
    const framed = media(FRAMED.id);
    await expect(framed).toBeVisible();
    await expect(framed).toHaveAttribute("data-fit", "cover");
    await expect(framed).toHaveAttribute("data-feed-framing", "region");
    await expect(framed).toHaveAttribute("style", /--feed-media-y:\s*0%/u);
    await expect(framed.locator("img")).toHaveCSS("object-fit", "cover");
    await expect(framed.locator("img")).toHaveCSS("object-position", "50% 0%");

    // 整张: the whole cover, its blank sides on the card's surface.
    const whole = media(WHOLE.id);
    await expect(whole).toBeVisible();
    await expect(whole).toHaveAttribute("data-fit", "contain");
    await expect(whole).toHaveAttribute("data-feed-framing", "whole");
    await expect(whole).not.toHaveAttribute("style", /--feed-media-y/u);
    await expect(whole.locator("img")).toHaveCSS("object-fit", "contain");
    const colours = await backgroundAndToken(
      whole,
      "--yoyi-color-background-surface",
    );
    expect(colours.token).not.toBe("");
    expect(colours.background).toBe(colours.token);

    // No framing read: the card covers its box at the centre, as before.
    const plain = media(PLAIN.id);
    await expect(plain).toBeVisible();
    await expect(plain).not.toHaveAttribute("data-fit");
    await expect(plain).not.toHaveAttribute("data-feed-framing");
    await expect(plain.locator("img")).toHaveCSS("object-fit", "cover");
    await expect(plain.locator("img")).toHaveCSS("object-position", "50% 50%");
  } finally {
    await home.close();
  }
});

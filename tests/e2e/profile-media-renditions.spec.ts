import { createHash } from "node:crypto";

import { devices, expect, test } from "@playwright/test";
import sharp from "sharp";
import type { Browser, Locator, Page, TestInfo } from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

const ACTION_TIMEOUT = 10_000;

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

/**
 * profile-media-renditions-v1 (#270): which profile image each surface loads.
 * Community requests are page routes with synthetic profiles; image bytes are
 * real PNG originals and WebP renditions at their recipe sizes, answered with
 * the relay's current-image headers. Browser emulation, not physical-device QA.
 */
interface Person {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}
const person = (digit: string, handle: string, displayName: string) => ({
  id: `user-${digit.repeat(32)}`,
  handle,
  displayName,
});
const viewer = person("a", "synthetic-renditions", "渲染测试读者");
const author = person("b", "synthetic-rendition-author", "渲染测试作者");
const commenters = [
  person("c", "synthetic-commenter-one", "评论读者甲"),
  person("d", "synthetic-commenter-two", "评论读者乙"),
];
/** A profile without an avatar whose followers list is opened. */
const listOwner = person("1", "synthetic-list-owner", "名单测试作者");
const followers = [
  person("e", "synthetic-follower-one", "关注读者甲"),
  person("f", "synthetic-follower-two", "关注读者乙"),
];
const mediaId = (n: number) => `user-media-${n.toString(16).padStart(32, "0")}`;
const avatarIds = new Map(
  [viewer, author, ...commenters, ...followers].map((entry, index) => [
    entry.id,
    mediaId(index + 1),
  ]),
);
const backgroundId = mediaId(100);
const original = (id: string) => `/api/community/media/${id}`;
const rendition = (id: string, role: string) => `${original(id)}/${role}`;

const AVATAR_SIDE = 1024;
// At least 1600 px wide, so the largest rendition is background-1600.
const BACKGROUND = { width: 2000, height: 1500 } as const;
const ROLES = {
  avatar: [
    ["avatar-128", 128, 128],
    ["avatar-512", 512, 512],
  ],
  background: [
    ["background-960", 960, 720],
    ["background-1600", 1600, 1200],
  ],
} as const;

const works = {
  author: {
    id: `work-${"b".repeat(32)}`,
    authorId: author.id,
    authorName: author.displayName,
    title: "渲染头像测试作品",
    text: "检查作品作者与评论头像只读取小尺寸图像。",
  },
  viewer: {
    id: `work-${"a".repeat(32)}`,
    authorId: viewer.id,
    authorName: viewer.displayName,
    title: "本人头像测试作品",
    text: "检查本人作品的头像同样只读取小尺寸图像。",
  },
} as const;
const workOf = (work: (typeof works)[keyof typeof works]) => ({
  ...work,
  media: [],
  firstPublishedAt: "2026-10-10T00:00:00.000Z",
  version: 1,
  canEdit: work.authorId === viewer.id,
  available: true,
});

const solid = (
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha?: number },
) =>
  sharp({
    create: {
      width,
      height,
      channels: background.alpha === undefined ? 3 : 4,
      background,
    },
  });

interface Served {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
}
const served = async (
  image: ReturnType<typeof solid>,
  format: "png" | "webp",
): Promise<Served> => {
  const body = await (
    format === "png" ? image.png() : image.webp({ quality: 80 })
  ).toBuffer();
  return {
    body,
    contentType: `image/${format}`,
    etag: `"${createHash("sha256").update(body).digest("hex")}"`,
  };
};

interface Options {
  /** Whether the Backend lists renditions (emission on, family ready). */
  readonly rendered: boolean;
  /** The viewer's own profile carries a cover. */
  readonly cover?: boolean;
  /** The viewer's own profile carries an avatar. */
  readonly viewerAvatar?: boolean;
  /** Discover lists two text works: another author's and the viewer's. */
  readonly feed?: boolean;
}

/**
 * Serves every community read the journeys make. Returns the paths of every
 * profile image the page requested, in order.
 */
async function fixture(page: Page, options: Options) {
  // Discovery precedes startup; load the package schema after fixtures are ready.
  const contracts = await import("@moya/contracts/schemas");
  const files = new Map<string, Served>();
  const requested: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/community/media/")) requested.push(path);
  });

  const media = async (
    id: string,
    family: keyof typeof ROLES,
    size: { width: number; height: number },
    fill: { r: number; g: number; b: number; alpha?: number },
  ) => {
    files.set(
      original(id),
      await served(solid(size.width, size.height, fill), "png"),
    );
    const renditions = [];
    for (const [role, width, height] of ROLES[family]) {
      files.set(
        rendition(id, role),
        await served(solid(width, height, fill), "webp"),
      );
      renditions.push({
        src: rendition(id, role),
        width,
        height,
        contentType: "image/webp",
      });
    }
    return {
      id,
      src: original(id),
      ...size,
      ...(options.rendered ? { renditions } : {}),
    };
  };
  const avatars = new Map<string, Awaited<ReturnType<typeof media>>>();
  for (const [index, [userId, id]] of [...avatarIds].entries())
    avatars.set(
      userId,
      // An avatar with transparency, as the WebP recipe keeps alpha.
      await media(
        id,
        "avatar",
        { width: AVATAR_SIDE, height: AVATAR_SIDE },
        { r: 40 + index * 20, g: 90, b: 120, alpha: 0.9 },
      ),
    );
  const background = options.cover
    ? await media(backgroundId, "background", BACKGROUND, {
        r: 84,
        g: 96,
        b: 90,
      })
    : null;

  const profile = (entry: Person) =>
    contracts.authorProfileSchema.parse({
      ...entry,
      bio: "",
      avatar:
        entry.id === viewer.id && !options.viewerAvatar
          ? null
          : (avatars.get(entry.id) ?? null),
      background: entry.id === viewer.id ? background : null,
      isOwner: entry.id === viewer.id,
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
        followers: followers.length,
        favorites: 0,
        likes: 0,
      },
      nextAvatarChangeAt: null,
    });
  const people = contracts.authorPeoplePageSchema.parse({
    items: followers.map((entry) => ({
      ...entry,
      avatar: avatars.get(entry.id),
    })),
    total: followers.length,
    page: 1,
    pageSize: 20,
  });
  const listed = options.feed ? Object.values(works) : [];
  const discover = contracts.discoveryPageSchema.parse({
    items: listed.map((work) => ({
      target: { type: "work", id: work.id },
      title: work.title,
      excerpt: work.text,
      aliases: [],
      kind: null,
      authorId: work.authorId,
      firstPublishedAt: "2026-10-10T00:00:00.000Z",
      media: null,
    })),
    sequence: "22222222-2222-4222-8222-222222222222",
    nextAfter: listed.length,
    hasMore: false,
  });
  const discussion = contracts.discussionPageSchema.parse({
    visibleTotal: commenters.length,
    hot: [],
    items: commenters.map((entry, index) => ({
      id: `comment-rendition-${index + 1}`,
      author: { id: entry.id, displayName: entry.displayName },
      text: "碑阴题名尤可玩味。",
      createdAt: "2026-10-11T00:00:00.000Z",
      likeCount: 0,
      liked: false,
      deleted: false,
      target: { type: "work", id: works.author.id },
      replies: [],
      replyTotal: 0,
      replyPageTotal: 0,
    })),
    total: commenters.length,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  const everyone = new Map(
    [viewer, author, listOwner, ...commenters, ...followers].map((entry) => [
      entry.id,
      entry,
    ]),
  );

  await page.route("**/api/community/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = files.get(path);
    if (file)
      // The relay's answer for a current image (closed-beta-access-v1).
      return route.fulfill({
        body: file.body,
        contentType: file.contentType,
        headers: {
          "cache-control": "private, no-cache",
          etag: file.etag,
          vary: "Cookie",
        },
      });
    if (path.startsWith("/api/community/media/"))
      return route.fulfill({
        status: 404,
        headers: { "cache-control": "private, no-store" },
      });
    if (path === "/api/community/me") return route.fulfill({ json: viewer });
    const authorPath = /^\/api\/community\/authors\/([^/]+)$/u.exec(path);
    const shown = authorPath && everyone.get(authorPath[1]!);
    if (shown) return route.fulfill({ json: profile(shown) });
    if (/^\/api\/community\/authors\/[^/]+\/followers$/u.test(path))
      return route.fulfill({ json: people });
    if (path === "/api/community/discover")
      return route.fulfill({ json: discover });
    for (const work of Object.values(works))
      if (path === `/api/community/works/${work.id}`)
        return route.fulfill({
          json: contracts.workSchema.parse(workOf(work)),
        });
    if (path === `/api/community/discussion/work/${works.author.id}`)
      return route.fulfill({ json: discussion });
    if (path === "/api/community/messages/unread")
      return route.fulfill({ json: { unreadConversations: 0 } });
    if (path === "/api/community/notifications/stream") return route.abort();
    return route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 12 },
    });
  });
  return requested;
}

/** Missing controls must fail finitely: global action and test timeouts are 0. */
const present = async (locator: Locator) => {
  await expect(locator).toBeVisible({ timeout: ACTION_TIMEOUT });
  return locator;
};
const click = async (locator: Locator) => {
  await (await present(locator)).click({ timeout: ACTION_TIMEOUT });
};

/** Brings a (possibly lazy) image into view and waits until it has decoded. */
async function painted(image: Locator) {
  await (
    await present(image)
  ).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
  await expect
    .poll(() =>
      image.evaluate((node: HTMLImageElement) =>
        node.complete ? node.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);
  return image.evaluate((node: HTMLImageElement) => ({
    currentSrc: new URL(node.currentSrc).pathname,
    naturalWidth: node.naturalWidth,
  }));
}

async function open(page: Page, path: string) {
  const response = await page.goto(path, { timeout: 30_000 });
  expect(response?.status()).toBe(200);
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
}

async function openOwnProfile(page: Page) {
  // A signed-in browser carries its session cookie: a wide screen shows the
  // dock once /me answers instead of browse-only (pc-browse-only-v1).
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  await addSessionCookie(page.context(), baseURL);
  await open(page, "/");
  await click(
    page
      .getByRole("navigation", { name: "主要内容" })
      .getByRole("button", { name: "用户", exact: true }),
  );
  await expect(
    page.getByRole("heading", { name: viewer.displayName, exact: true }),
  ).toBeVisible();
}

/**
 * The phone single-column feed. On desktop Chromium the phone is an emulated
 * context; mobile WebKit uses its own page.
 */
async function phone(browser: Browser, page: Page, testInfo: TestInfo) {
  if (testInfo.project.name !== "desktop-chromium")
    return { page, close: async () => {} };
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    baseURL,
  });
  return { page: await context.newPage(), close: () => context.close() };
}

const skipUnlessProject = (testInfo: TestInfo) =>
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "Covered on phone WebKit and desktop Chromium.",
  );

test("feed, comment and people avatars load only avatar-128", async ({
  browser,
  page,
}, testInfo) => {
  skipUnlessProject(testInfo);
  const target = await phone(browser, page, testInfo);
  try {
    const requested = await fixture(target.page, {
      rendered: true,
      viewerAvatar: true,
      feed: true,
    });
    const avatarOf = (entry: Person) => avatarIds.get(entry.id)!;
    const thumb = (entry: Person) => ({
      currentSrc: rendition(avatarOf(entry), "avatar-128"),
      naturalWidth: 128,
    });

    // The single-column posts (36 px): another author's, and the viewer's own.
    await open(target.page, "/");
    for (const [work, owner] of [
      [works.author, author],
      [works.viewer, viewer],
    ] as const)
      expect(
        await painted(
          target.page.locator(
            `[data-feed-post][data-content-id="${work.id}"] [data-feed-post-author] img`,
          ),
        ),
        owner.displayName,
      ).toEqual(thumb(owner));

    // The work's author line and its comments.
    await open(target.page, `/?workId=${works.author.id}#detail`);
    await expect(
      target.page.locator("[data-detail-state=loaded]"),
    ).toBeVisible();
    expect(
      await painted(
        target.page
          .getByRole("button", { name: author.displayName })
          .locator("img"),
      ),
    ).toEqual(thumb(author));
    await click(target.page.getByRole("tab", { name: /^评论/u }));
    for (const entry of commenters)
      expect(
        await painted(
          target.page
            .getByRole("img", { name: `${entry.displayName}的头像` })
            .locator("img"),
        ),
        entry.displayName,
      ).toEqual(thumb(entry));

    // A followers list (48 px).
    await open(target.page, `/?authorId=${listOwner.id}#profile`);
    await click(target.page.getByRole("button", { name: /^粉丝/u }));
    for (const entry of followers)
      expect(
        await painted(
          target.page
            .getByRole("button", { name: new RegExp(entry.displayName, "u") })
            .locator("img"),
        ),
        entry.displayName,
      ).toEqual(thumb(entry));

    // Nothing but avatar-128, never the original PNG.
    for (const entry of [viewer, author, ...commenters, ...followers]) {
      const id = avatarOf(entry);
      const paths = requested.filter((path) => path.startsWith(original(id)));
      expect(paths.length, entry.displayName).toBeGreaterThan(0);
      expect(new Set(paths), entry.displayName).toEqual(
        new Set([rendition(id, "avatar-128")]),
      );
    }
  } finally {
    await target.close();
  }
});

test("the profile header offers avatar-128 at 1x and avatar-512 from 2x", async ({
  page,
}, testInfo) => {
  skipUnlessProject(testInfo);
  const requested = await fixture(page, {
    rendered: true,
    viewerAvatar: true,
  });
  await openOwnProfile(page);
  const id = avatarIds.get(viewer.id)!;
  const image = page.getByRole("button", { name: "更换头像" }).locator("img");
  await expect(image).toHaveAttribute("src", rendition(id, "avatar-128"));
  await expect(image).toHaveAttribute(
    "srcset",
    `${rendition(id, "avatar-128")} 128w, ${rendition(id, "avatar-512")} 512w`,
  );
  await expect(image).toHaveAttribute("sizes", "80px");
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  const chosen = rendition(id, ratio >= 2 ? "avatar-512" : "avatar-128");
  expect((await painted(image)).currentSrc).toBe(chosen);
  expect(requested.filter((path) => path.startsWith(original(id)))).toEqual([
    chosen,
  ]);
});

test("the cover loads one background rendition for its three layers and is tinted from it", async ({
  page,
}, testInfo) => {
  skipUnlessProject(testInfo);
  const requested = await fixture(page, { rendered: true, cover: true });
  await openOwnProfile(page);
  const cover = rendition(backgroundId, "background-1600");
  const root = page.locator("[data-author-profile]").first();
  const photo = root.locator(':scope > [aria-label="主页背景"] img');
  const compact = root.locator(':scope > [aria-label="主页背景"] + div > img');
  await expect(photo).toHaveAttribute("src", cover);
  await expect(compact).toHaveAttribute("src", cover);
  // The frost of each layer draws the same image.
  const frost = await root
    .locator(":scope [style*='background-image']")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).style.backgroundImage),
    );
  expect(frost).toEqual([`url("${cover}")`, `url("${cover}")`]);
  expect((await painted(photo)).naturalWidth).toBe(1600);
  await expect
    .poll(() =>
      compact.evaluate((node: HTMLImageElement) =>
        node.complete ? node.naturalWidth : 0,
      ),
    )
    .toBe(1600);
  // The tint is sampled under the displayed URL, so it applies.
  await expect
    .poll(() =>
      root.evaluate((node: HTMLElement) =>
        node.style.getPropertyValue("--cover-tint"),
      ),
    )
    .not.toBe("");
  expect(
    requested.filter((path) => path.startsWith(original(backgroundId))),
  ).toEqual([cover]);
});

test("without renditions every profile surface keeps the original image", async ({
  page,
}, testInfo) => {
  skipUnlessProject(testInfo);
  const requested = await fixture(page, {
    rendered: false,
    viewerAvatar: true,
    cover: true,
  });
  await openOwnProfile(page);
  const own = avatarIds.get(viewer.id)!;
  const header = page.getByRole("button", { name: "更换头像" }).locator("img");
  await expect(header).toHaveAttribute("src", original(own));
  await expect(header).not.toHaveAttribute("srcset");
  await expect(header).not.toHaveAttribute("sizes");
  expect((await painted(header)).currentSrc).toBe(original(own));
  const root = page.locator("[data-author-profile]").first();
  const photo = root.locator(':scope > [aria-label="主页背景"] img');
  await expect(photo).toHaveAttribute("src", original(backgroundId));
  await expect(
    root.locator(':scope > [aria-label="主页背景"] + div > img'),
  ).toHaveAttribute("src", original(backgroundId));
  expect((await painted(photo)).naturalWidth).toBe(BACKGROUND.width);
  await expect
    .poll(() =>
      root.evaluate((node: HTMLElement) =>
        node.style.getPropertyValue("--cover-tint"),
      ),
    )
    .not.toBe("");
  await click(page.getByRole("button", { name: /^粉丝/u }));
  for (const entry of followers) {
    const id = avatarIds.get(entry.id)!;
    expect(
      (
        await painted(
          page
            .getByRole("button", { name: new RegExp(entry.displayName, "u") })
            .locator("img"),
        )
      ).currentSrc,
    ).toBe(original(id));
  }
  // No rendition path is ever requested.
  expect(
    requested.filter((path) => /\/(avatar|background)-\d+$/u.test(path)),
  ).toEqual([]);
  for (const id of [
    own,
    backgroundId,
    ...followers.map((entry) => avatarIds.get(entry.id)!),
  ])
    expect(requested).toContain(original(id));
});

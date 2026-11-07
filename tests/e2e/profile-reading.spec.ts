import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { addSessionCookie } from "./support/session-cookie";

// Explicit synthetic account/content. No production session or data is used.
const owner = `user-${"6".repeat(32)}`;
const identity = {
  id: owner,
  handle: "reading-qa",
  displayName: "合成验收作者",
};
const id = (n: number) => `work-${String(n).padStart(32, "0")}`;
const mediaId = (n: number) => `media-item-${String(n).padStart(32, "0")}`;
const backgroundId = `user-media-${"9".repeat(32)}`;
const avatarId = `user-media-${"7".repeat(32)}`;
const title = (n: number) => {
  if (n === 4 || n === 11) return "";
  if (n === 5) return "iCloud 2026 study";
  if (n === 7) return "长篇合成书法题名保留完整字形".repeat(12);
  if (n === 8) return "长篇纯文字作品题名".repeat(12);
  if (n === 9) return "A long synthetic Latin title ".repeat(12);
  if (n === 10) return "临帖与 iCloud 2026 A4 混排".repeat(12);
  return `合成临帖 ${n} 号`;
};
const dimensions = (n: number): readonly [number, number] =>
  n % 3 === 1 ? [900, 1600] : n % 3 === 2 ? [2400, 600] : [1200, 1200];
const work = (n: number) => {
  const [width, height] = dimensions(n);
  return {
    id: id(n),
    authorId: owner,
    authorName: identity.displayName,
    title: title(n),
    text:
      n === 4 || n === 8 || n === 11
        ? "这是用于验证纯文字展读的合成正文。A4 临帖记录，保留原文与阅读顺序。".repeat(
            15,
          )
        : "",
    media:
      n === 4 || n === 8
        ? []
        : [
            {
              id: mediaId(n),
              src: `/api/community/publishing/media/${mediaId(n)}/display/base`,
              width,
              height,
              kind: n === 3 ? "live" : "static",
              ...(n === 3
                ? {
                    motionSrc: `/api/community/publishing/media/${mediaId(n)}/motion/base`,
                    hasAudio: false,
                  }
                : {}),
            },
            ...(n === 3
              ? [
                  {
                    id: mediaId(30),
                    src: `/api/community/publishing/media/${mediaId(30)}/display/base`,
                    width,
                    height,
                    kind: "static",
                  },
                ]
              : []),
          ],
    firstPublishedAt: "2026-09-20T00:00:00.000Z",
    version: 1,
    canEdit: true,
    available: n !== 1,
    visibility: n === 1 ? "self" : "public",
    publiclyVisible: n !== 1,
  };
};

async function prepare(
  page: Page,
  normal = false,
  brokenImage = false,
  coverFirst = false,
  options: { photo?: boolean; bio?: string; name?: string } = {},
) {
  let brokenRequests = 0;
  await page.addInitScript(
    (layout) => {
      localStorage.setItem("yoyi.home-feed-layout.v2", layout);
      localStorage.setItem("yoyi.desktop-feed-layout.v1", layout);
    },
    normal ? "double" : "single",
  );
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing fixture URL");
  await addSessionCookie(page.context(), baseURL);
  await page.route("**/api/community/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (path === "/api/community/me") return route.fulfill({ json: identity });
    if (path === `/api/community/media/${backgroundId}`)
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#54605a"/><path d="M0 900L380 180L800 900L1200 300L1600 900" fill="#384640"/><text x="800" y="1060" text-anchor="middle" font-size="80" fill="#ded5bf">合成封面验收</text></svg>',
      });
    if (path === `/api/community/media/${avatarId}`)
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#b34a32"/><text x="48" y="62" text-anchor="middle" fill="#fff" font-size="44">验</text></svg>',
      });
    if (path === `/api/community/authors/${owner}`)
      return route.fulfill({
        json: {
          ...identity,
          displayName: options.name ?? identity.displayName,
          bio:
            options.bio ?? "合成验收资料，用于检查完整封面与展读作品的衔接。",
          ...(options.photo === false
            ? {}
            : {
                background: {
                  id: backgroundId,
                  src: `/api/community/media/${backgroundId}`,
                  width: 1600,
                  height: 1200,
                },
              }),
          studioName: "临池阁",
          avatar: {
            id: avatarId,
            src: `/api/community/media/${avatarId}`,
            width: 96,
            height: 96,
          },
          isOwner: true,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "public",
            likes: "public",
          },
          totals: {
            works: 24,
            following: 1,
            followers: 2,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        },
      });
    if (path === `/api/community/authors/${owner}/works`) {
      const p = Number(url.searchParams.get("page") || 1);
      return route.fulfill({
        json: {
          items: Array.from({ length: 12 }, (_, i) =>
            work((p - 1) * 12 + i + 1),
          ),
          total: 24,
          page: p,
          pageSize: 12,
        },
      });
    }
    if (
      path === `/api/community/authors/${owner}/favorites` ||
      path === `/api/community/authors/${owner}/likes`
    )
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    if (path.includes("/publishing/drafts"))
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    if (path.endsWith("/state"))
      return route.fulfill({
        json: {
          favorite: false,
          liked: false,
          favoriteCount: 0,
          likeCount: 0,
          commentCount: 0,
        },
      });
    const media = path.match(
      /\/publishing\/media\/media-item-(\d+)\/display\/base$/,
    );
    if (media) {
      const n = Number(media[1]),
        [width, height] = dimensions(n);
      if (brokenImage && n === 6 && brokenRequests++ === 0)
        return route.fulfill({ status: 503, body: "Synthetic image failure" });
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#eee5d3"/><rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#ab4036" stroke-width="16"/><text x="50%" y="50%" text-anchor="middle" fill="#27241f" font-size="${Math.min(width, height) / 8}">合成书法 ${n}</text></svg>`,
      });
    }
    const detail = path.match(/\/works\/work-(\d+)$/);
    if (detail) return route.fulfill({ json: work(Number(detail[1])) });
    const card = path.match(/\/content\/work\/work-(\d+)\/card$/);
    if (card) {
      const entry = work(Number(card[1]));
      return route.fulfill({
        json: {
          target: { type: "work", id: entry.id },
          title: entry.title,
          excerpt: entry.text,
          aliases: [],
          kind: null,
          authorId: owner,
          firstPublishedAt: entry.firstPublishedAt,
          media: entry.media[0] ?? null,
        },
      });
    }
    if (path.includes("/comments"))
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    return route.continue();
  });
  await page.goto("/");
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主要内容", exact: true })
    .getByRole("button", { name: "用户", exact: true })
    .click();
  const root = page.locator(`[data-author-profile="${owner}"]`);
  await expect(
    root.getByRole("heading", {
      name: options.name ?? identity.displayName,
      exact: true,
    }),
  ).toBeVisible();
  await expect(root.locator("[data-content-id]")).not.toHaveCount(0);
  if (!coverFirst) await enterWorks(root);
  return root;
}

async function enterWorks(root: Locator) {
  const hint = root.getByRole("button", { name: "向下查看作品", exact: true });
  // A long identity on a short screen uses the native free cover. Reach its
  // lower controls before clicking; the floating primary dock covers the edge.
  if (
    await root.evaluate(
      (node) =>
        node.hasAttribute("data-cover-free") &&
        !node.hasAttribute("data-cover-snap"),
    )
  )
    await hint.evaluate((node) =>
      node.scrollIntoView({ block: "center", behavior: "instant" }),
    );
  if (!(await hint.evaluate((node) => node.hasAttribute("inert")))) {
    await expectHitTarget(hint);
    await hint.click();
  }
  await expect(root).toHaveAttribute("data-profile-stage", "content");
  // Stage/progress change before the final pin shift. A real hold must start
  // only once native smooth scrolling, snapping and viewport motion settle.
  await root.evaluate(async (node) => {
    const pc =
      document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-platform") === "pc";
    const scroller = pc
      ? document.documentElement
      : node.closest<HTMLElement>('[data-primary-destination="user"]')!;
    const started = performance.now();
    let previous = "",
      stable = 0;
    while (stable < 30) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const tabs = node
        .querySelector('[role="tablist"]')!
        .getBoundingClientRect();
      const state = [
        scroller.scrollTop,
        tabs.top,
        visualViewport?.height,
        visualViewport?.offsetTop,
      ]
        .map((n) => Math.round((n ?? 0) * 10))
        .join(":");
      stable = state === previous ? stable + 1 : 0;
      previous = state;
      if (performance.now() - started > 5000)
        throw new Error("Profile cover did not settle");
    }
  });
}

const profileScroll = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector<HTMLElement>("[data-author-profile]")!;
    const pc =
      document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-platform") === "pc";
    return (
      (pc
        ? document.scrollingElement
        : (r.closest<HTMLElement>('[data-primary-destination="user"]') ?? r)
      )?.scrollTop ?? 0
    );
  });

test.beforeEach(async ({ page }, info) => {
  page.setDefaultTimeout(45_000);
  test.skip(
    !/^(desktop|mobile|tablet)/.test(info.project.name),
    "Phone, tablet and PC profile slice",
  );
  test.setTimeout(60_000);
});

test("fixed calligraphy reading has complete images, private tools and real vertical desktop text", async ({
  page,
}, info) => {
  const root = await prepare(page, false, false, true),
    pc = info.project.name.startsWith("desktop");
  await expect(root).not.toHaveAttribute("data-profile-reading");
  const background = root.locator('[aria-label="主页背景"] img');
  await expect(background).toBeVisible();
  await expect
    .poll(() =>
      background.evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1600);
  await expect(root).toHaveAttribute("data-profile-stage", "cover");
  const photo = await background.boundingBox();
  expect(photo!.height).toBeGreaterThan(page.viewportSize()!.height * 0.7);
  await page.screenshot({
    path: info.outputPath("complete-profile-cover.png"),
  });
  await expect(root.getByRole("tab")).toHaveCount(4);
  await expect(
    root.getByRole("button", { name: "总览", exact: true }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", { name: "展读", exact: true }),
  ).toHaveCount(0);
  await expect(root.locator("[data-drafts-tool]")).toHaveCount(1);
  await expect(root.locator("[data-drafts-card]")).toHaveCount(0);
  const search = root.getByRole("button", { name: "打开搜索", exact: true });
  const searchBox = await search.boundingBox();
  expect(searchBox?.x).toBeGreaterThanOrEqual(0);
  expect(searchBox?.width).toBe(pc ? 320 : 44);
  await expect(search.locator('[data-icon="search"]')).toBeVisible();
  await expect(
    root.getByRole("button", { name: "编辑主页背景", exact: true }),
  ).toBeInViewport();
  if (!pc)
    await expect(
      root.getByRole("button", { name: "设置", exact: true }),
    ).toBeInViewport();
  const loadedMasks = await page
    .locator("[data-icon]")
    .evaluateAll(async (icons) => {
      const urls = [
        ...new Set(
          icons
            .flatMap((icon) => {
              const style = getComputedStyle(icon);
              return [
                style.getPropertyValue("mask-image"),
                style.getPropertyValue("-webkit-mask-image"),
              ];
            })
            .filter((value) => value.startsWith("url("))
            .map((value) => value.slice(4, -1).replace(/^['"]|['"]$/g, "")),
        ),
      ];
      await Promise.all(
        urls.map(async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
        }),
      );
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return urls.length;
    });
  expect(loadedMasks).toBeGreaterThan(0);
  const avatar = root.getByRole("button", { name: "更换头像", exact: true });
  await expect
    .poll(() =>
      avatar
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  // The canonical circular entry clips its image; image radius need not duplicate it.
  await expect(avatar).toHaveCSS("border-radius", "999px");
  await expect(avatar).toHaveCSS("overflow", "hidden");
  if (
    info.project.name === "mobile-webkit" &&
    (await root.evaluate((n) => n.hasAttribute("data-cover-snap")))
  ) {
    const hint = await root
      .getByRole("button", { name: "向下查看作品", exact: true })
      .boundingBox();
    const dock = await page
      .locator("[data-primary-navigation-dock]")
      .boundingBox();
    // Includes the 8px pseudo-element tap extension and 5px floating motion.
    expect(hint!.y + hint!.height + 13).toBeLessThanOrEqual(dock!.y);
  }
  await enterWorks(root);
  await expect(root).toHaveAttribute("data-profile-condensed", "");
  const summary = root.locator("[data-profile-summary]");
  await expect(summary).toBeVisible();
  await expect(summary).not.toHaveAttribute("inert");
  await expect(root.locator('[aria-label="用户资料"]')).toHaveAttribute(
    "inert",
    "",
  );
  const tabsBox = await root.getByRole("tablist").boundingBox();
  const barBox = await root.locator(":scope > header").boundingBox();
  expect(Math.abs(tabsBox!.y - barBox!.y - barBox!.height)).toBeLessThanOrEqual(
    1,
  );
  const cards = root.locator("[data-profile-reading-card]");
  await expect(cards).toHaveCount(12);
  await expect(cards.first().locator("img")).toHaveCSS("object-fit", "contain");
  await expect(
    cards.first().getByText("仅自己可见", { exact: true }),
  ).toBeVisible();
  const live = cards.nth(2).getByRole("img", { name: "实况照片", exact: true });
  const count = cards
    .nth(2)
    .getByRole("img", { name: "2 张图像", exact: true });
  const liveBox = await live.boundingBox(),
    countBox = await count.boundingBox();
  expect(liveBox).not.toBeNull();
  expect(countBox).not.toBeNull();
  expect(liveBox!.x + liveBox!.width).toBeLessThanOrEqual(countBox!.x);
  const heading = cards.first().getByRole("heading");
  await expect(heading).toHaveCSS("writing-mode", "vertical-rl");
  if (pc) {
    const first = await cards.nth(0).boundingBox(),
      second = await cards.nth(1).boundingBox();
    expect(first!.x).toBeGreaterThan(second!.x);

    await expect(cards.nth(4).getByRole("heading")).toHaveCSS(
      "writing-mode",
      "vertical-rl",
    );
  } else {
    const dock = await page
      .getByRole("navigation", { name: "主要内容", exact: true })
      .boundingBox();
    if (!dock) throw new Error("No existing phone dock");
    const complete = await cards.evaluateAll(
      (nodes, bottom) =>
        nodes.filter((n) => {
          const b = n.getBoundingClientRect();
          return b.top >= 0 && b.bottom <= bottom && b.width > 0;
        }).length,
      dock.y,
    );
    expect(complete).toBeGreaterThanOrEqual(4);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("fixed-reading.png"),
    fullPage: false,
  });
  await expect(root.locator("[data-profile-ip-location]")).toBeAttached();
});

test("compact author info expands the original cover and resumes the selected reading position", async ({
  page,
}, info) => {
  const root = await prepare(page);
  const selected = root.locator(
    `[data-profile-reading-card][data-content-id="${id(12)}"]`,
  );
  await selected.scrollIntoViewIfNeeded();
  const before = await profileScroll(page);
  const beforeBox = await selected.boundingBox();
  const summary = root.getByRole("button", {
    name: `查看${identity.displayName}的完整资料`,
    exact: true,
  });
  await expectHitTarget(summary);
  await summary.click();
  await expect(root).not.toHaveAttribute("data-profile-condensed");
  const full = root.locator('[aria-label="用户资料"]');
  await expect(full).not.toHaveAttribute("inert");
  await expect(
    full.getByRole("heading", { name: identity.displayName, exact: true }),
  ).toBeFocused();
  await expect(full.locator("[data-profile-ip-location]")).toBeVisible();
  await page.screenshot({ path: info.outputPath("author-info-expanded.png") });
  const resume = root.getByRole("button", {
    name: "返回作品展读",
    exact: true,
  });
  await expectHitTarget(resume);
  await resume.click();
  await expect(root).toHaveAttribute("data-profile-condensed", "");
  await expect
    .poll(async () => Math.abs((await profileScroll(page)) - before))
    .toBeLessThanOrEqual(2);
  const afterBox = await selected.boundingBox();
  expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThanOrEqual(2);
  // A fractional card edge may clip by less than one CSS pixel in WebKit.
  // Preserve the actual position and prove the restored opener receives a click.
  await selected
    .getByRole("button", { name: `打开${title(12)}`, exact: true })
    .click();
  await expect(page).toHaveURL((url) => url.hash === "#detail");
});

for (const photo of [true, false]) {
  test(`long author information stays reachable with photo=${photo} and a single-line Works summary`, async ({
    page,
  }, info) => {
    const name = "窄屏验收作者姓名与Studio2026混排示例";
    const bio = "临池读帖，完整资料和原文保留，检查长简介与书法展读的切换。"
      .repeat(30)
      .slice(0, 500);
    const root = await prepare(page, false, false, true, { photo, name, bio });
    const full = root.locator('[aria-label="用户资料"]');
    await expect(
      full.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    expect(await full.locator("p").allTextContents()).toContain(bio);
    if (
      !photo ||
      info.project.name === "mobile-webkit" ||
      info.project.name === "tablet-landscape-webkit"
    )
      await expect(root).not.toHaveAttribute("data-cover-snap");
    const selected = root.locator(
      `[data-profile-reading-card][data-content-id="${id(12)}"]`,
    );
    await selected.scrollIntoViewIfNeeded();
    await expect(root).toHaveAttribute("data-profile-condensed", "");
    const summary = root.getByRole("button", {
      name: `查看${name}的完整资料`,
      exact: true,
    });
    await expectHitTarget(summary);
    const summaryName = summary.locator("strong");
    await expect(summaryName).toHaveCSS("white-space", "nowrap");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await summary.click();
    await expect(full).not.toHaveAttribute("inert");
    await expect(
      full.getByRole("heading", { name, exact: true }),
    ).toBeFocused();
    expect(await full.locator("p").allTextContents()).toContain(bio);
    // The original cover keeps its own management/relationship actions.
    await expect(
      full.getByRole("button", { name: "关注 1", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`long-author-photo-${photo}.png`),
    });
    const resume = root.getByRole("button", {
      name: "返回作品展读",
      exact: true,
    });
    await expectHitTarget(resume);
    await resume.click();
    await selected.scrollIntoViewIfNeeded();
    await expect(root).toHaveAttribute("data-profile-condensed", "");
  });
}

test("an image retry is operable above the card opener and does not navigate", async ({
  page,
}) => {
  const root = await prepare(page, false, true);
  const card = root.locator(
    `[data-profile-reading-card][data-content-id="${id(6)}"]`,
  );
  await card.scrollIntoViewIfNeeded();
  const retry = card.getByRole("button", {
    name: `重试图像：${title(6)}`,
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(card.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      card.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page).not.toHaveURL((url) => url.hash === "#detail");
});

async function prepareOther(page: Page, guest = false) {
  await prepare(page);
  const other = `user-${"8".repeat(32)}`;
  await page.route(`**/api/community/authors/${other}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/works"))
      return route.fulfill({
        json: {
          items: [
            {
              ...work(2),
              authorId: other,
              authorName: "另一位合成作者",
              canEdit: false,
              visibility: undefined,
              publiclyVisible: undefined,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 12,
        },
      });
    return route.fulfill({
      json: {
        id: other,
        handle: "other-reading-qa",
        displayName: "另一位合成作者",
        bio: "",
        avatar: null,
        isOwner: false,
        following: false,
        privacy: {
          following: "public",
          followers: "public",
          favorites: "private",
          likes: "private",
        },
        totals: {
          works: 1,
          following: 1,
          followers: 1,
          favorites: null,
          likes: null,
        },
        nextAvatarChangeAt: null,
      },
    });
  });
  if (guest) {
    await page.context().clearCookies();
    await page.route("**/api/community/me", (route) =>
      route.fulfill({ status: 401, json: { error: "not_signed_in" } }),
    );
  }
  await page.goto(`/?authorId=${other}#profile`);
  const root = page.locator(`[data-author-profile="${other}"]`);
  await expect(
    root.getByRole("heading", { name: "另一位合成作者", exact: true }),
  ).toBeVisible();
  return root;
}

test("another author has reading works and public relationship actions but no owner tools", async ({
  page,
}) => {
  const root = await prepareOther(page);
  await expect(root).not.toHaveAttribute("data-profile-reading");
  await expect(root.locator("[data-profile-reading-card]")).toHaveCount(1);
  await expect(
    root.getByRole("button", { name: "关注", exact: true }),
  ).toBeVisible();
  await expect(root.locator("[data-drafts-tool]")).toHaveCount(0);
  await expect(
    root.getByRole("tab", { name: "历史", exact: true }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", { name: "编辑主页背景", exact: true }),
  ).toHaveCount(0);
});

const expectHitTarget = async (target: Locator) => {
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return hit !== null && (hit === node || node.contains(hit));
      }),
    )
    .toBe(true);
};

test("profile block and report menus receive real pointer clicks above the reading chrome", async ({
  page,
}) => {
  const root = await prepareOther(page);
  const more = root.getByRole("button", { name: "更多操作", exact: true });
  await more.click();
  const block = root.getByRole("menuitem", { name: "屏蔽", exact: true });
  await expectHitTarget(block);
  let confirmation = "";
  page.once("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.dismiss();
  });
  await block.click();
  expect(confirmation).toContain("屏蔽 另一位合成作者");
  await more.click();
  const report = root.getByRole("menuitem", { name: "举报用户", exact: true });
  await expectHitTarget(report);
  await report.click();
  await expect(
    page.getByRole("dialog", { name: "举报", exact: true }),
  ).toBeVisible();
});

test("a signed-out reader can click report and enter the existing sign-in flow", async ({
  page,
}) => {
  const root = await prepareOther(page, true);
  await expect(
    root.getByRole("link", { name: "登录后关注", exact: true }),
  ).toBeVisible();
  await root.getByRole("button", { name: "更多操作", exact: true }).click();
  const report = root.getByRole("menuitem", { name: "举报", exact: true });
  await expectHitTarget(report);
  await report.click();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
});

test("the reading background editor uses the canonical phone and desktop reference ratios", async ({
  page,
}) => {
  const root = await prepare(page, false, false, true);
  await root.getByRole("button", { name: "编辑主页背景", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "主页背景", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "手机", exact: true }).click();
  const phoneRatio = await dialog
    .locator('[data-cover-preview="phone"]')
    .evaluate((n) => getComputedStyle(n).aspectRatio);
  expect(phoneRatio).not.toBe("auto");
  await dialog.getByRole("tab", { name: "电脑", exact: true }).click();
  const desktopRatio = await dialog
    .locator('[data-cover-preview="desktop"]')
    .evaluate((n) => getComputedStyle(n).aspectRatio);
  expect(desktopRatio).not.toBe("auto");
});

test("long reading titles end on whole columns and leave room for the text excerpt", async ({
  page,
}, info) => {
  if (info.project.name === "mobile-webkit")
    await page.setViewportSize({ width: 320, height: 800 });
  const root = await prepare(page);
  for (const n of [7, 8, 9, 10]) {
    const card = root.locator(
      `[data-profile-reading-card][data-content-id="${id(n)}"]`,
    );
    await card.scrollIntoViewIfNeeded();
    const heading = card.getByRole("heading", { name: title(n), exact: true });
    await expect(heading).toHaveCSS("-webkit-line-clamp", "2");
    const metrics = await heading.evaluate((node) => {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect();
      const vertical = style.writingMode.startsWith("vertical");
      const caption = node.parentElement!;
      const padding = getComputedStyle(caption);
      return {
        blockSize: vertical ? box.width : box.height,
        lineHeight: Number.parseFloat(style.lineHeight),
        vertical,
        capacity:
          caption.clientWidth -
          Number.parseFloat(padding.paddingLeft) -
          Number.parseFloat(padding.paddingRight),
      };
    });
    expect(metrics.blockSize).toBeLessThanOrEqual(2 * metrics.lineHeight + 1);
    if (metrics.vertical && n !== 8)
      expect(metrics.capacity).toBeCloseTo(2 * metrics.lineHeight, 0);
    await expect(
      card.getByRole("button", { name: `打开${title(n)}`, exact: true }),
    ).toHaveCount(1);
  }
  const textCard = root.locator(
    `[data-profile-reading-card][data-content-id="${id(8)}"]`,
  );
  await textCard.scrollIntoViewIfNeeded();
  const excerpt = textCard.locator("[data-card-excerpt]");
  const room = await excerpt.evaluate((node) => {
    const box = node.getBoundingClientRect(),
      parent = node.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(node);
    const vertical = style.writingMode.startsWith("vertical");
    return {
      visible: vertical
        ? Math.min(box.right, parent.right) - Math.max(box.left, parent.left)
        : Math.min(box.bottom, parent.bottom) - Math.max(box.top, parent.top),
      line: Number.parseFloat(style.lineHeight),
    };
  });
  expect(room.visible).toBeGreaterThanOrEqual(room.line - 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("long-reading-text.png") });
});

test("the reading opener shows hold feedback and suppresses native touch selection", async ({
  page,
}) => {
  const root = await prepare(page);
  const opener = root
    .locator("[data-profile-reading-card]")
    .first()
    .getByRole("button", { name: `打开${title(1)}`, exact: true });
  await expect(opener).toHaveCSS(
    test.info().project.name.includes("webkit")
      ? "-webkit-user-select"
      : "user-select",
    "none",
  );
  if (await page.evaluate(() => CSS.supports("-webkit-touch-callout", "none")))
    await expect(opener).toHaveCSS("-webkit-touch-callout", "none");
  else
    test.info().annotations.push({
      type: "capability",
      description:
        "Host WebKit does not expose iOS touch-callout; physical iOS acceptance remains separate.",
    });
  expect(
    await opener.evaluate((node) =>
      ["top", "right", "bottom", "left"].every(
        (side) =>
          Number.parseFloat(
            getComputedStyle(node).getPropertyValue(
              `--quick-action-safe-${side}`,
            ),
          ) >= 0,
      ),
    ),
  ).toBe(true);
  await page.clock.install();
  const box = await opener.boundingBox();
  if (!box) throw new Error("No reading opener geometry");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await opener.evaluate((node) => {
    node.addEventListener(
      "pointerdown",
      (event) =>
        node.setAttribute(
          "data-test-pointer-id",
          String((event as PointerEvent).pointerId),
        ),
      { once: true },
    );
  });
  await page.mouse.down();
  const recordedPointer = await opener.getAttribute("data-test-pointer-id");
  expect(recordedPointer).not.toBeNull();
  const pointerId = Number(recordedPointer);
  await page.clock.fastForward(250);
  await expect(opener).toHaveAttribute("data-quick-action-phase", "holding");
  await expect(opener).not.toHaveCSS("box-shadow", "none");
  await page.clock.fastForward(200);
  await expect(opener).toHaveAttribute("data-quick-action-phase", "menu-open");
  await expect(opener).not.toHaveCSS("box-shadow", "none");
  await opener.dispatchEvent("pointercancel", { pointerId });
  await page.mouse.up();
  await expect(opener).toHaveAttribute("data-quick-action-phase", "idle");
  await expect(opener).toHaveCSS("box-shadow", "none");
  await expect(page).not.toHaveURL((url) => url.hash === "#detail");
});

test("reading keeps the selected work and position through Detail, collection and history", async ({
  page,
}) => {
  const root = await prepare(page);
  const selected = root.locator(
    `[data-profile-reading-card][data-content-id="${id(12)}"]`,
  );
  await selected.scrollIntoViewIfNeeded();
  const before = await profileScroll(page);
  expect(before).toBeGreaterThan(100);
  await selected
    .getByRole("button", { name: `打开${title(12)}`, exact: true })
    .click();
  await expect(page).toHaveURL((url) => url.hash === "#detail");
  await page.getByRole("button", { name: "返回", exact: true }).last().click();
  await expect(root).toBeVisible();
  await expect
    .poll(async () => Math.abs((await profileScroll(page)) - before))
    .toBeLessThanOrEqual(2);
  await root.getByRole("tab", { name: "收藏", exact: true }).click();
  await expect(
    root.getByText("暂无可显示的内容", { exact: true }),
  ).toBeVisible();
  await root.getByRole("tab", { name: "作品", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await profileScroll(page)) - before))
    .toBeLessThanOrEqual(2);
  await root.getByRole("tab", { name: "历史", exact: true }).click();
  await expect(
    root.getByRole("tab", { name: "历史", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await root.getByRole("tab", { name: "作品", exact: true }).click();
  await expect
    .poll(async () => Math.abs((await profileScroll(page)) - before))
    .toBeLessThanOrEqual(2);
});

test("normal profiles retain the existing renderer and private drafts card", async ({
  page,
}) => {
  const root = await prepare(page, true);
  await expect(root).not.toHaveAttribute("data-profile-reading");
  await expect(root.locator("[data-profile-reading-card]")).toHaveCount(0);
  await expect(root.locator("[data-drafts-card]")).toBeVisible();
  await expect(
    root.getByRole("tab", { name: "历史", exact: true }),
  ).toHaveCount(1);
});

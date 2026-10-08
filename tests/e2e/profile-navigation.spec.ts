import { expect, test } from "@playwright/test";
import sharp from "sharp";
import type { Page } from "@playwright/test";

const ownerId = `user-${"7".repeat(32)}`;
const identity = {
  id: ownerId,
  handle: "synthetic-scroll",
  displayName: "滚动测试作者",
};
const profile = {
  ...identity,
  bio: "用于检查用户资料加载后的共同吸顶位置。".repeat(12),
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "public",
    followers: "public",
    favorites: "public",
    likes: "public",
  },
  totals: { works: 12, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
};
const coverId = `user-media-${"9".repeat(32)}`;
async function fixture(page: Page, delayed = false, cover = false) {
  let resolveProfile = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveProfile = resolve;
  });
  if (!delayed) resolveProfile();
  await page.route("**/api/community/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/community/me") return route.fulfill({ json: identity });
    if (path === `/api/community/authors/${ownerId}`) {
      await ready;
      return route.fulfill({
        json: {
          ...profile,
          bio: delayed ? profile.bio : "滚动回归合成资料。",
          ...(cover
            ? {
                background: {
                  id: coverId,
                  src: `/api/community/media/${coverId}`,
                  width: 1600,
                  height: 1200,
                },
              }
            : {}),
        },
      });
    }
    if (path === `/api/community/media/${coverId}`)
      return route.fulfill({
        contentType: "image/png",
        body: await sharp({
          create: {
            width: 1600,
            height: 1200,
            channels: 3,
            background: { r: 84, g: 96, b: 90 },
          },
        })
          .png()
          .toBuffer(),
      });
    if (path === `/api/community/authors/${ownerId}/works`)
      return route.fulfill({
        json: {
          items: Array.from({ length: 12 }, (_, index) => ({
            id: `work-${String(index + 1).padStart(32, "0")}`,
            authorId: ownerId,
            authorName: identity.displayName,
            title:
              index === 11
                ? "滚动测试作品 12"
                : `滚动测试作品 ${index + 1}：用于检查收藏和喜欢切换后保留长正文阅读位置`,
            text: "保留正文阅读位置。".repeat(28),
            media: [],
            firstPublishedAt: "2026-09-20T00:00:00.000Z",
            version: 1,
            canEdit: true,
            available: true,
          })),
          total: 12,
          page: 1,
          pageSize: 12,
        },
      });
    if (/\/(favorites|likes)$/.test(path))
      return route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 12 },
      });
    return route.continue();
  });
  await page.goto("/");
  // A tap before the shell has booted is lost.
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true })
    .click();
  await expect(
    page.locator(`[data-author-profile="${ownerId}"]`),
  ).toBeVisible();
  if (!delayed)
    await expect(
      page.getByRole("heading", { name: identity.displayName, exact: true }),
    ).toBeVisible();
  // Primary navigation restores its saved scroll in two animation frames.
  // Wait for that existing handoff before starting a separate user scroll.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
  return resolveProfile;
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const profile = document.querySelector<HTMLElement>(
      "[data-author-profile]",
    )!;
    const primary = profile.closest<HTMLElement>("[data-primary-destination]")!;
    const scroll =
      document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-platform") === "pc"
        ? document.documentElement
        : primary;
    return {
      top: scroll.scrollTop,
      max: scroll.scrollHeight - scroll.clientHeight,
      tabsTop: profile
        .querySelector('[role="tablist"]')!
        .getBoundingClientRect().top,
      headerBottom: profile.querySelector("header")!.getBoundingClientRect()
        .bottom,
      // The cover runs up under the top bar, so the tabs pin after scrolling
      // the cover's height less the bar's.
      collapse:
        profile
          .querySelector('[aria-label="用户资料"]')!
          .getBoundingClientRect().height -
        profile.querySelector("header")!.offsetHeight,
    };
  });
}
async function scrollTo(page: Page, top: number) {
  await page.evaluate((value) => {
    const pc =
      document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-platform") === "pc";
    const target = pc
      ? document.documentElement
      : document.querySelector<HTMLElement>(
          '[data-primary-destination="user"]',
        )!;
    target.scrollTop = value;
    (pc ? window : target).dispatchEvent(new Event("scroll"));
  }, top);
}
async function tab(page: Page, name: string) {
  const target = page.getByRole("tab", { name, exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("Missing visible profile tab");
  // Click its visible sticky position, without scrolling its original flow box.
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
  await expect
    .poll(async () => {
      const g = await geometry(page);
      return Math.abs(g.tabsTop - g.headerBottom);
    })
    .toBeLessThanOrEqual(1);
  // Pinned tabs sit under a solid top bar (profile-hero-layout-v1).
  await expect(
    page.locator("[data-author-profile] > header").first(),
  ).toHaveAttribute("data-cover-passed", "");
}

test("Profile empty collections share collapse and preserve long body offsets", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    page.getByRole("button", { name: "打开滚动测试作品 12", exact: true }),
  ).toBeAttached();
  // Without a photo there is no photo layer, compact cover or snapping: the
  // header stays on the page colour and the page scrolls freely.
  const bare = page.locator("[data-author-profile]").first();
  await expect(bare.locator(':scope > [aria-label="主页背景"]')).toHaveCSS(
    "display",
    "none",
  );
  await expect(
    bare.locator(':scope > [aria-label="主页背景"] + div'),
  ).toHaveCount(0);
  await expect(bare).not.toHaveAttribute("data-cover-snap");
  const initial = await geometry(page);
  const longTop = initial.collapse + 420;
  await expect
    .poll(async () => (await geometry(page)).max)
    .toBeGreaterThan(longTop);
  await scrollTo(page, longTop);
  await pinned(page);
  await tab(page, "收藏");
  await expect(
    page.getByRole("tabpanel", { name: "收藏", exact: true }),
  ).toContainText("暂无可显示的内容");
  await pinned(page);
  await tab(page, "作品");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - longTop))
    .toBeLessThanOrEqual(1);
  await tab(page, "喜欢");
  await pinned(page);
  const pager = page.locator("[data-author-profile] [data-horizontal-pager]");
  if ((await pager.getAttribute("data-category-pager-engine")) === "embla") {
    await expect
      .poll(async () =>
        Number(await pager.getAttribute("data-horizontal-pager-progress")),
      )
      .toBeCloseTo(2, 3);
    await pager.evaluate((element) => {
      const frame = element as HTMLElement;
      for (const [type, fraction] of [
        ["touchstart", 0],
        ["touchmove", 0.3],
        ["touchmove", 0.7],
        ["touchmove", 1],
        ["touchend", 1],
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
                    clientX: frame.clientWidth * (0.8 - fraction),
                    clientY: 300,
                  },
                ],
        });
        frame.dispatchEvent(event);
      }
    });
    await expect(
      page.getByRole("tab", { name: "历史", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  } else await tab(page, "历史");
  await pinned(page);
  await scrollTo(page, 0);
  await expect.poll(async () => (await geometry(page)).top).toBe(0);
  await tab(page, "收藏");
  expect((await geometry(page)).top).toBe(0);
  await scrollTo(page, 100000);
  await pinned(page);
  const g = await geometry(page);
  expect(Math.abs(g.top - g.collapse)).toBeLessThanOrEqual(1);
});

/** Where the identity rests, where it is, and the stage shown. */
async function stage(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-author-profile]")!;
    const pc =
      document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-platform") === "pc";
    const port = pc
      ? document.documentElement
      : root.closest<HTMLElement>('[data-primary-destination="user"]')!;
    const bar = root.querySelector<HTMLElement>(":scope > header")!;
    const name = root.querySelector<HTMLElement>("h1")!;
    const names = name.closest("div")!;
    // The owner's avatar is followed by its hidden file input.
    const avatar = names.parentElement!.firstElementChild!;
    // The compact cover follows the photo: the photo's top part, over the
    // collections, carrying the frost and the glass card.
    const compact = root.querySelector<HTMLElement>(
      '[aria-label="主页背景"] + div',
    )!;
    const photo = compact.getBoundingClientRect();
    const [frost, glassCard] = [...compact.querySelectorAll(":scope > span")];
    const glass = getComputedStyle(frost!);
    const card = glassCard!.getBoundingClientRect();
    const tabs = root
      .querySelector<HTMLElement>('[role="tablist"]')!
      .getBoundingClientRect();
    const pinned = Number.parseFloat(
      root.style.getPropertyValue("--cover-pinned"),
    );
    // What a tap just below the tabs reaches.
    const below = document.elementFromPoint(
      tabs.left + tabs.width / 2,
      tabs.bottom + 12,
    );
    // What a tap on the compact cover, just above the tabs, reaches.
    const above = document.elementFromPoint(
      tabs.left + tabs.width / 2,
      tabs.top - 8,
    );
    const counts = root
      .querySelector<HTMLElement>("h1")!
      .closest("div")!
      .parentElement!.parentElement!.lastElementChild!.getBoundingClientRect();
    return {
      rest: Number.parseFloat(root.style.getPropertyValue("--cover-rest")),
      // The collections stage: their top under the compact cover.
      second: Math.round(
        root
          .querySelector<HTMLElement>('[aria-label="用户内容"]')!
          .getBoundingClientRect().top +
          port.scrollTop -
          pinned,
      ),
      snap: getComputedStyle(port).scrollSnapType,
      barBottom: bar.getBoundingClientRect().bottom,
      avatarTop: avatar.getBoundingClientRect().top,
      photoTop: photo.top,
      photoHeight: photo.height,
      glass: glass.opacity,
      frosted: glass.filter,
      cardTop: card.top,
      cardBottom: card.bottom,
      rowBottom: counts.bottom,
      tabsTop: tabs.top,
      belowTabs: below
        ? below.closest('[aria-label="用户资料"]')
          ? "cover"
          : "collections"
        : null,
      aboveTabs: above?.closest('[aria-label="用户内容"]')
        ? "collections"
        : "cover",
      nameTop: name.getBoundingClientRect().top,
      stage: root.getAttribute("data-profile-stage"),
      theme: names.getAttribute("data-theme"),
    };
  });
}

/** Share of differing pixels between two screenshots of one area. */
async function difference(first: Buffer, second: Buffer) {
  const [a, b] = await Promise.all(
    [first, second].map((image) =>
      sharp(image).raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  let changed = 0;
  const pixels = a!.info.width * a!.info.height;
  for (let offset = 0; offset < a!.data.length; offset += a!.info.channels)
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(a!.data[offset + channel]! - b!.data[offset + channel]!) >
          12,
      )
    )
      changed++;
  return changed / pixels;
}

test("A photo profile rests on the photo or on the collections", async ({
  page,
}) => {
  await fixture(page, false, true);
  // The photo, then the compact cover with its frost and glass card.
  await expect(
    page.locator('[data-author-profile] [aria-label="主页背景"] img'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-author-profile] [aria-label="主页背景"] + div > span'),
  ).toHaveCount(2);
  await expect.poll(async () => (await stage(page)).rest).toBeGreaterThan(60);
  const { rest, second } = await stage(page);
  expect(second).toBeGreaterThan(rest);
  // The scroller snaps natively between the two resting places (#237).
  expect(await stage(page)).toMatchObject({
    stage: "cover",
    theme: "dark",
    glass: "0",
    snap: "y mandatory",
  });
  const hint = page.getByRole("button", { name: "向下查看作品" });
  await expect(hint).toHaveCSS("opacity", "1");
  await expect(hint).not.toHaveAttribute("inert");
  // Left short of half way, the page settles back on the whole photo…
  await scrollTo(page, Math.round(second * 0.4));
  await expect.poll(async () => (await geometry(page)).top).toBe(0);
  // …and past it, on the collections: never in between.
  await scrollTo(page, Math.round(second * 0.6));
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - second))
    .toBeLessThanOrEqual(1);
  const rested = await stage(page);
  expect(rested).toMatchObject({
    stage: "content",
    theme: "dark",
    glass: "1",
    belowTabs: "collections",
    aboveTabs: "cover",
  });
  expect(rested.frosted).toMatch(/blur/u);
  // The tabs pin right under the identity's actions.
  expect(Math.abs(rested.tabsTop - rested.rowBottom)).toBeLessThanOrEqual(24);
  // The identity rests just under the top bar, on a glass card that ends
  // just above the tabs.
  expect(rested.avatarTop - rested.barBottom).toBeGreaterThanOrEqual(8);
  expect(rested.avatarTop - rested.barBottom).toBeLessThanOrEqual(16);
  expect(rested.avatarTop - rested.cardTop).toBeCloseTo(10, 0);
  expect(rested.tabsTop - rested.cardBottom).toBeGreaterThan(2);
  expect(rested.tabsTop - rested.cardBottom).toBeLessThanOrEqual(10);
  // The compact cover stays at the top and ends where the pinned tabs begin.
  expect(Math.abs(rested.photoTop)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(rested.photoTop + rested.photoHeight - rested.tabsTop),
  ).toBeLessThanOrEqual(2);
  await expect(hint).toHaveAttribute("inert", "");
  await expect(hint).toHaveCSS("opacity", "0");
  // Further down only the collections move, under the compact cover: it
  // looks exactly as it did, and its taps never reach a hidden work (#237).
  const viewport = page.viewportSize()!;
  const cover = {
    x: 0,
    y: 0,
    width: viewport.width - 24,
    height: Math.floor(rested.tabsTop) - 3,
  };
  // Let the stage's colour transitions and the card's tint sampling settle.
  await page.waitForTimeout(600);
  const before = await page.screenshot({ clip: cover });
  // To the collections' real end: a scroll past it is a distance, not a place.
  const { max } = await geometry(page);
  expect(max).toBeGreaterThan(second + 40);
  await scrollTo(page, max);
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - max))
    .toBeLessThanOrEqual(1);
  await page.waitForTimeout(300);
  const deep = await stage(page);
  expect(Math.abs(deep.nameTop - rested.nameTop)).toBeLessThan(1);
  expect(deep.aboveTabs).toBe("cover");
  // Text may re-rasterise; collections passing over it would change most of
  // it.
  expect(
    await difference(before, await page.screenshot({ clip: cover })),
  ).toBeLessThan(0.01);
  // Back to the collections' top, then into the gap: short of half way from
  // the collections it settles back on them, past it the whole photo returns
  // with the hint.
  await scrollTo(page, Math.round(second * 0.7));
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - second))
    .toBeLessThanOrEqual(1);
  await scrollTo(page, Math.round(second * 0.3));
  await expect.poll(async () => (await geometry(page)).top).toBe(0);
  expect(await stage(page)).toMatchObject({ stage: "cover", theme: "dark" });
  await expect(hint).toHaveCSS("opacity", "1");
  await expect(hint).not.toHaveAttribute("inert");
});

/** The photo layer's top edge on screen (the page's own sticky layer). */
async function photoTop(page: Page) {
  return page
    .locator('[data-author-profile] > [aria-label="主页背景"] > div')
    .first()
    .evaluate((photo) => photo.getBoundingClientRect().top);
}

test("A photo profile keeps each collection's place under the compact cover", async ({
  page,
}) => {
  await fixture(page, false, true);
  await expect.poll(async () => (await stage(page)).rest).toBeGreaterThan(60);
  const { second } = await stage(page);
  // The photo stays at the top on the photo and at the collections stage.
  for (const top of [0, second]) {
    await scrollTo(page, top);
    await expect
      .poll(async () => Math.abs((await geometry(page)).top - top))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(await photoTop(page))).toBeLessThanOrEqual(1);
  }
  // Inside the collections the page rests where it is left, under the
  // compact cover, and the photo stays put.
  const { max } = await geometry(page);
  expect(max).toBeGreaterThan(second + 40);
  const inside = Math.min(max - 1, second + 160);
  await scrollTo(page, inside);
  await page.waitForTimeout(400);
  expect(Math.abs((await geometry(page)).top - inside)).toBeLessThanOrEqual(1);
  expect(Math.abs(await photoTop(page))).toBeLessThanOrEqual(1);
  expect(await stage(page)).toMatchObject({
    stage: "content",
    aboveTabs: "cover",
  });
  // An empty collection rests at the collections stage; each collection
  // keeps its own place.
  await tab(page, "收藏");
  await expect(
    page.getByRole("tabpanel", { name: "收藏", exact: true }),
  ).toContainText("暂无可显示的内容");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - second))
    .toBeLessThanOrEqual(1);
  expect(await stage(page)).toMatchObject({ stage: "content" });
  await tab(page, "作品");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - inside))
    .toBeLessThanOrEqual(1);
  await tab(page, "喜欢");
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - second))
    .toBeLessThanOrEqual(1);
});

test("A photo profile keeps its stage when the viewport changes", async ({
  page,
}) => {
  await fixture(page, false, true);
  await expect.poll(async () => (await stage(page)).rest).toBeGreaterThan(60);
  const viewport = page.viewportSize()!;
  const { second } = await stage(page);
  await scrollTo(page, second);
  await expect
    .poll(async () => Math.abs((await geometry(page)).top - second))
    .toBeLessThanOrEqual(1);
  // A shorter screen re-measures both stages: the page stays on the
  // collections, never back on the photo or pulled past their end.
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height - 60,
  });
  await expect
    .poll(async () => {
      const [at, now] = [await stage(page), await geometry(page)];
      return Math.abs(now.top - at.second);
    })
    .toBeLessThanOrEqual(1);
  expect(await stage(page)).toMatchObject({
    stage: "content",
    aboveTabs: "cover",
  });
  await page.setViewportSize(viewport);
  await expect
    .poll(async () => {
      const [at, now] = [await stage(page), await geometry(page)];
      return Math.abs(now.top - at.second);
    })
    .toBeLessThanOrEqual(1);
  expect(Math.abs(await photoTop(page))).toBeLessThanOrEqual(1);
});

test("A photo profile too tall to pin scrolls freely and keeps its hint", async ({
  page,
}) => {
  // A landscape phone leaves too little room to pin the identity.
  await page.setViewportSize({ width: 844, height: 360 });
  await fixture(page, false, true);
  const root = page.locator("[data-author-profile]").first();
  await expect(root).toHaveAttribute("data-cover-free", "");
  await expect(root).not.toHaveAttribute("data-cover-snap");
  await expect.poll(async () => (await stage(page)).rest).toBeGreaterThan(20);
  const { rest } = await stage(page);
  // The collections' skirt (the identity's bottom shade) stays in the
  // page's own layer, under the scroll hint (#237 review).
  expect(
    await page
      .locator('[data-author-profile] > [aria-label="用户内容"]')
      .first()
      .evaluate((content) => getComputedStyle(content, "::before").zIndex),
  ).toBe("auto");
  // At this size the chevron rests below the fold; it is on the photo stage.
  await expect(
    page.getByRole("button", { name: "向下查看作品" }),
  ).not.toHaveAttribute("inert");
  // No snapping: a place between the two is kept, the photo held at the top.
  const between = Math.round(rest / 3);
  await scrollTo(page, between);
  await page.waitForTimeout(400);
  expect(Math.abs((await geometry(page)).top - between)).toBeLessThanOrEqual(1);
  expect(Math.abs(await photoTop(page))).toBeLessThanOrEqual(1);
  // Past the identity's resting place the photo scrolls away with it.
  await scrollTo(page, Math.round(rest) + 100);
  await page.waitForTimeout(400);
  const top = (await geometry(page)).top;
  expect(Math.abs((await photoTop(page)) - (rest - top))).toBeLessThanOrEqual(
    2,
  );
  // There is no compact cover to hold the photo's top part.
  await expect(
    page.locator('[data-author-profile] > [aria-label="主页背景"] + div'),
  ).toHaveCSS("display", "none");
});

test("Profile remains pinned after delayed identity and bio load", async ({
  page,
}) => {
  const release = await fixture(page, true);
  await scrollTo(page, (await geometry(page)).collapse);
  await pinned(page);
  await tab(page, "收藏");
  await pinned(page);
  release();
  await expect(
    page.getByRole("heading", { name: identity.displayName, exact: true }),
  ).toBeAttached();
  await pinned(page);
  await scrollTo(page, 0);
  expect((await geometry(page)).top).toBe(0);
});

for (const surface of ["home", "discussion"] as const) {
  for (const width of [320, 390]) {
    test(`${surface} icons follow continuous forward and reversed swipes at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expect(page.locator("[data-product-boot]")).toHaveCount(0);
      if (surface === "discussion") {
        await page
          .getByRole("navigation", { name: "主要内容" })
          .getByRole("button", { name: "讨论", exact: true })
          .click();
      }
      const home = page.locator(`[data-${surface}-surface]`);
      const incomingKey = surface === "home" ? "nearby" : "threads";
      const incomingLabel = surface === "home" ? "附近" : "话题";
      const pager = home.locator("[data-horizontal-pager-scroll-owner]");
      await expect(pager).toHaveAttribute(
        "data-category-pager-engine",
        "embla",
      );
      // The engine name is present in SSR; its first published progress proves
      // that the client engine has attached before the input sequence starts.
      await expect(pager).toHaveAttribute(
        "data-horizontal-pager-progress",
        /^-?\d+(?:\.\d+)?$/u,
      );
      const samples = await pager.evaluate(async (element, incomingKey) => {
        const frame = element as HTMLElement;
        const home = frame.closest(
          "[data-home-surface], [data-discussion-surface]",
        )!;
        const samples: {
          progress: number;
          previousProgress: number;
          underline: string;
          activation: number;
          opacity: number;
          scale: number;
          clipped: boolean;
          transitions: string;
          scroll: number;
        }[] = [];
        const touch = (type: string, fraction: number) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", {
            value:
              type === "touchend"
                ? []
                : [
                    {
                      identifier: 1,
                      target: frame,
                      clientX: frame.clientWidth * (0.85 - fraction),
                      clientY: 300,
                    },
                  ],
          });
          frame.dispatchEvent(event);
        };
        touch("touchstart", 0);
        for (const fraction of [0.08, 0.2, 0.4, 0.6, 0.8, 0.6, 0.4, 0.2, 0]) {
          touch("touchmove", fraction);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const previousProgress = Number(
            frame.dataset.horizontalPagerProgress,
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const button = home.querySelector<HTMLElement>(
            `[data-tab-key="${incomingKey}"]`,
          )!;
          const slot = button.querySelector<HTMLElement>(
            '[aria-hidden="true"]',
          )!;
          const icon = slot.firstElementChild!;
          const box = icon.getBoundingClientRect(),
            bound = slot.getBoundingClientRect();
          const style = getComputedStyle(icon);
          samples.push({
            progress: Number(frame.dataset.horizontalPagerProgress),
            previousProgress,
            underline: (
              home.querySelector("[data-top-tab-indicator]") as HTMLElement
            ).style.transform,
            activation: Number(
              getComputedStyle(button).getPropertyValue("--top-tab-activation"),
            ),
            opacity: Number(getComputedStyle(slot).opacity),
            scale: new DOMMatrixReadOnly(style.transform).a,
            clipped:
              box.left < bound.left - 0.2 || box.right > bound.right + 0.2,
            transitions: style.transitionDuration,
            scroll: home.querySelector<HTMLElement>("[data-animated-top-tabs]")!
              .scrollLeft,
          });
        }
        touch("touchend", 0);
        return samples;
      }, incomingKey);
      expect(samples.some((sample) => sample.progress > 0.25)).toBe(true);
      expect(
        new Set(samples.map((sample) => sample.underline)).size,
      ).toBeGreaterThan(3);
      for (const sample of samples) {
        // Embla writes its frame before React commits the header. Accept only
        // the current or immediately preceding frame, never arbitrary lag.
        expect(
          Math.min(
            ...[sample.progress, sample.previousProgress].map((progress) =>
              Math.abs(sample.activation - progress),
            ),
          ),
        ).toBeLessThan(0.00005);
        expect(sample.opacity).toBeCloseTo(sample.activation, 4);
        expect(sample.scale).toBeCloseTo(sample.activation, 4);
        expect(sample.clipped).toBe(false);
        expect(sample.transitions).toBe("0s");
      }
      expect(new Set(samples.map((sample) => sample.scroll)).size).toBe(1);
      await expect(home).toHaveAttribute(
        `data-active-${surface}-feed`,
        surface === "home" ? "discover" : "news",
      );
      await expect
        .poll(async () =>
          Number(await pager.getAttribute("data-horizontal-pager-progress")),
        )
        .toBeCloseTo(0, 5);
      await home.getByRole("tab", { name: incomingLabel, exact: true }).click();
      await expect(home).toHaveAttribute(
        `data-active-${surface}-feed`,
        incomingKey,
      );
      await expect
        .poll(async () =>
          Number(
            await home
              .locator(`[data-tab-key="${incomingKey}"]`)
              .evaluate((node) =>
                getComputedStyle(node).getPropertyValue("--top-tab-activation"),
              ),
          ),
        )
        .toBeCloseTo(1, 4);
    });
  }
}

for (const width of [320, 390]) {
  test(`Home category icons track pager motion through repeated transitions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator("[data-product-boot]")).toHaveCount(0);
    const home = page.locator("[data-home-surface]");
    await home.getByRole("tab", { name: "附近", exact: true }).click();
    await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
    await expect
      .poll(async () =>
        home
          .locator('[data-tab-key="nearby"] [aria-hidden="true"]')
          .first()
          .evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBeCloseTo(1, 5);
    for (const [key, label, index] of [
      ["inscriptions", "碑刻", 2],
      ["calligraphy", "书帖", 3],
      ["nearby", "附近", 1],
    ] as const) {
      const capture = home.evaluate(async (element, target) => {
        const button = element.querySelector<HTMLElement>(
          `[data-tab-key="${target}"]`,
        )!;
        const slot = button.querySelector<HTMLElement>('[aria-hidden="true"]')!;
        const glyph = button.querySelector<HTMLElement>("[data-icon]")!;
        const samples: {
          opacity: number;
          activation: number;
          sameNode: boolean;
          labelGap: number;
          mask: string;
          scale: number;
          progress: number;
          previousProgress: number;
          transitions: string;
        }[] = [];
        const pager = element.querySelector<HTMLElement>(
          "[data-horizontal-pager]",
        )!;
        let previousProgress = Number(pager.dataset.horizontalPagerProgress);
        // A fixed frame count can stop before the click and spring settle.
        // Capture through actual completion under a bounded wall-clock deadline.
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          samples.push({
            opacity: Number(getComputedStyle(slot).opacity),
            activation: Number(
              button.style.getPropertyValue("--top-tab-activation"),
            ),
            sameNode: button.querySelector("[data-icon]") === glyph,
            labelGap:
              button.lastElementChild!.getBoundingClientRect().left -
              glyph.getBoundingClientRect().right,
            mask: getComputedStyle(glyph).maskImage,
            scale: new DOMMatrixReadOnly(
              getComputedStyle(slot.firstElementChild!).transform,
            ).a,
            progress: Number(
              element.querySelector<HTMLElement>("[data-horizontal-pager]")!
                .dataset.horizontalPagerProgress,
            ),
            previousProgress,
            transitions: getComputedStyle(slot).transitionDuration,
          });
          previousProgress = Number(pager.dataset.horizontalPagerProgress);
          if (
            button.getAttribute("aria-selected") === "true" &&
            pager.dataset.horizontalPagerScrolling === "false" &&
            Math.abs(samples.at(-1)!.opacity - 1) < 0.000005
          )
            break;
        }
        return samples;
      }, key);
      await home.getByRole("tab", { name: label, exact: true }).click();
      const samples = await capture;
      expect(samples.at(-1)?.opacity).toBeCloseTo(1, 5);
      expect(
        samples.some(
          (sample) => sample.opacity > 0.05 && sample.opacity < 0.95,
        ),
      ).toBe(true);
      expect(
        samples
          .filter((sample) => sample.opacity > 0)
          .every((sample) => sample.labelGap >= 4 * sample.activation - 0.5),
      ).toBe(true);
      expect(
        samples.every(
          (sample) => sample.sameNode && sample.transitions === "0s",
        ),
      ).toBe(true);
      expect(new Set(samples.map((sample) => sample.mask))).toEqual(
        new Set(["none"]),
      );
      const glyph = home.locator(`[data-tab-key="${key}"] [data-icon]`);
      await expect(glyph).toHaveAttribute("data-icon-renderer", "svg");
      expect(
        await glyph.evaluate((node) => node instanceof SVGSVGElement),
      ).toBe(true);
      const outline = glyph.locator('path[stroke="currentColor"]');
      await expect(outline).toHaveCount(1);
      await expect(outline).toHaveAttribute("fill", "none");
      // The canonical Calligraphy artwork also includes a filled ink shape.
      // Check both paint roles without assuming every glyph has one path.
      await expect(glyph.locator('path[fill="currentColor"]')).toHaveCount(
        key === "calligraphy" ? 1 : 0,
      );
      await expect(glyph.locator("path")).toHaveCount(
        key === "calligraphy" ? 2 : 1,
      );
      // DOM/CSS consistency alone missed the phone symptom. Also exercise
      // the actual vector paint in both themes; device acceptance stays separate.
      for (const theme of ["light", "dark"] as const) {
        await page.locator("html").evaluate((node, theme) => {
          node.dataset.theme = theme;
        }, theme);
        const { data, info } = await sharp(await glyph.screenshot())
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let ink = 0;
        for (let offset = 0; offset < data.length; offset += info.channels) {
          if (
            Math.max(
              ...[0, 1, 2].map((channel) =>
                Math.abs(data[offset + channel]! - data[channel]!),
              ),
            ) > 40
          )
            ink++;
        }
        expect(
          ink,
          `${key} vector has visible strokes in ${theme}`,
        ).toBeGreaterThan(8);
      }
      await page.locator("html").evaluate((node) => {
        delete node.dataset.theme;
      });
      for (const sample of samples) {
        const expected = [sample.progress, sample.previousProgress].map(
          (progress) => Math.max(0, 1 - Math.abs(index - progress)),
        );
        expect(
          Math.min(
            ...expected.map((activation) =>
              Math.abs(sample.activation - activation),
            ),
          ),
        ).toBeLessThan(0.00005);
        expect(sample.opacity).toBeCloseTo(sample.activation, 4);
        expect(sample.scale).toBeCloseTo(sample.activation, 4);
      }
      for (let i = 1; i < samples.length; i++)
        expect(samples[i]!.opacity + 0.001).toBeGreaterThanOrEqual(
          samples[i - 1]!.opacity,
        );
      await expect(home).toHaveAttribute("data-active-home-feed", key);
      await expect
        .poll(async () =>
          Number(
            await home
              .locator("[data-horizontal-pager]")
              .getAttribute("data-horizontal-pager-progress"),
          ),
        )
        .toBeCloseTo(index, 3);
      const bounds = await home
        .locator(`[data-tab-key="${key}"] [data-icon]`)
        .evaluate((node) => {
          const icon = node.getBoundingClientRect();
          const viewport = node
            .closest("[data-animated-top-tabs]")!
            .getBoundingClientRect();
          return {
            left: icon.left - viewport.left,
            right: viewport.right - icon.right,
            width: icon.width,
            height: icon.height,
          };
        });
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeGreaterThanOrEqual(-1);
      expect(bounds.width).toBeCloseTo(20, 3);
      expect(bounds.height).toBeCloseTo(20, 3);
    }
  });
}

import { expect, test } from "@playwright/test";

import type { Locator, Page, TestInfo } from "@playwright/test";

const runtimeIds = {
  calligraphy: "runtime-calligraphy",
  mismatch: "runtime-identity-mismatch",
  multiMedia: "runtime-inscription-multi-media",
  noMedia: "runtime-inscription-no-media",
} as const;

type PresentationPlatform = "pc" | "phone" | "tablet";

const expectedInitialPlatform = (projectName: string): PresentationPlatform => {
  if (projectName === "mobile-webkit") return "phone";
  if (projectName.startsWith("tablet")) return "tablet";
  return "pc";
};

// pc-browse-only-v1: the fixture issues no session, so every page here is a
// visitor without an account. These projects open at the wide layout (desktop
// 1280, iPad landscape 1194), where such a visitor only browses; iPhone and
// iPad portrait (834) keep everything.
const wideAnonymous = (projectName: string) =>
  projectName.startsWith("desktop") ||
  projectName === "tablet-landscape-webkit";

// Below the 896 px wide layout a desktop window is a "tablet" with the dock.
const narrowViewport = { height: 900, width: 800 } as const;

const restoreProjectViewport = async (page: Page, testInfo: TestInfo) => {
  const viewport = testInfo.project.use.viewport;
  if (!viewport) throw new Error(`${testInfo.project.name} has no viewport`);
  await page.setViewportSize(viewport);
};

// Identifiers in the shape the deep-link parsers accept.
const sampleHex = "0123456789abcdef0123456789abcdef";

const formalSurface = (page: Page) =>
  page.locator("[data-clean-product-preview]");

const productShell = (page: Page) =>
  formalSurface(page).locator("[data-product-shell]");

const primaryNavigation = (page: Page) =>
  formalSurface(page).getByRole("navigation", { name: "主要内容" });

const activeCatalogOpener = (shell: Locator, catalogId: string) =>
  shell
    .locator(
      '[data-primary-destination="home"] [data-home-feed-panel][aria-hidden="false"]',
    )
    .locator(`[data-catalog-id="${catalogId}"] [data-open-catalog]`);

const selectPrimaryDestination = async (
  page: Page,
  name: "首页" | "讨论" | "用户",
  destination: "home" | "discussion" | "user",
) => {
  // Browse-only hides the dock; an unguarded click would wait forever.
  const button = primaryNavigation(page).getByRole("button", {
    exact: true,
    name,
  });
  await expect(button).toBeVisible();
  await button.click();
  await expect(productShell(page)).toHaveAttribute(
    "data-active-destination",
    destination,
  );
};

/** Browse-only hides the whole dock; otherwise the dock is shown. */
const expectBrowseOnly = async (page: Page, browseOnly: boolean) => {
  const shell = productShell(page);
  await expect(shell).toHaveAttribute(
    "data-browse-only",
    browseOnly ? "true" : "false",
  );
  if (browseOnly) {
    await expect(
      shell.locator("[data-primary-navigation-layer]"),
    ).toHaveAttribute("hidden");
    await expect(primaryNavigation(page)).toHaveCount(0);
  } else {
    await expect(primaryNavigation(page)).toBeVisible();
  }
};

/** A browse-only Detail reads without comments, actions or a sign-in entry. */
const expectBrowseOnlyDetail = async (detail: Locator) => {
  await expect(detail.locator("[data-comment-section]")).toHaveCount(0);
  await expect(detail.locator("[data-detail-landscape-comments]")).toHaveCount(
    0,
  );
  await expect(detail.locator("[data-detail-content-actions]")).toHaveCount(0);
  await expect(detail.locator('a[href^="/login"]')).toHaveCount(0);
};

const selectHomeFeed = async (
  page: Page,
  name: "发现" | "附近" | "碑刻" | "书帖",
  feed: "discover" | "nearby" | "inscriptions" | "calligraphy",
) => {
  // Reading may minimize navigation while Home is already selected. Re-clicking
  // its hidden label adds no navigation behavior and blocks the actual tab.
  if (
    (await productShell(page).getAttribute("data-active-destination")) !==
    "home"
  ) {
    await selectPrimaryDestination(page, "首页", "home");
  }
  const home = productShell(page).locator("[data-home-surface]");
  const tab = home.getByRole("tab", { exact: true, name });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
};

const openFormalRoot = async (page: Page, target = "/") => {
  const response = await page.goto(target);
  expect(response?.status()).toBe(200);
  const surface = formalSurface(page);
  const shell = productShell(page);
  await expect(surface).toBeVisible();
  await expect(shell).toBeVisible();
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  return { shell, surface };
};

const detailDialog = (page: Page) =>
  productShell(page).getByRole("dialog", { name: "资料详情" });

const viewerDialog = (page: Page) =>
  productShell(page).getByRole("dialog", { name: "图像查看" });

const isPlainHomeUrl = (url: URL) =>
  url.pathname === "/" && url.search === "" && url.hash === "";

const isFormalPrimaryUrl = (url: URL) =>
  url.pathname === "/" &&
  url.searchParams.get("catalogId") === null &&
  url.searchParams.get("image") === null &&
  url.hash === "";

const isFormalDetailUrl = (url: URL, catalogId: string) =>
  url.pathname === "/" &&
  url.searchParams.get("catalogId") === catalogId &&
  url.searchParams.get("image") === null &&
  url.hash === "#detail";

const isFormalViewerUrl = (url: URL, catalogId: string, mediaId: string) =>
  url.pathname === "/" &&
  url.searchParams.get("catalogId") === catalogId &&
  url.searchParams.get("image") === mediaId &&
  url.hash === "#viewer";

test("Retired phone diagnostics links render the normal application", async ({
  page,
  request,
}) => {
  await openFormalRoot(page, "/?phoneDiagnostics=1");
  await expect(page.locator("[data-phone-diagnostics]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "开始记录", exact: true }),
  ).toHaveCount(0);
  const response = await request.post("/api/dev/phone-diagnostics", {
    data: {},
  });
  expect(response.status()).toBe(404);
});

test("Formal root serves only the request-rendered React Product Shell", async ({
  page,
  request,
}, testInfo) => {
  const getResponse = await request.get("/");
  expect(getResponse.status()).toBe(200);
  const initialHtml = await getResponse.text();
  expect(initialHtml).toContain("data-product-shell");
  expect(initialHtml).toContain("data-clean-product-preview");
  expect(initialHtml).not.toContain('data-formal-root="true"');
  expect(initialHtml).not.toContain("data-mobile-app");

  const headResponse = await request.head("/");
  expect(headResponse.status()).toBe(200);
  expect(await headResponse.body()).toHaveLength(0);

  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration/iu.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/hydration/iu.test(error.message)) hydrationErrors.push(error.message);
  });
  await page.addInitScript(() => {
    const runtime = window as Window & {
      __moyaOldFormalObserved?: boolean;
    };
    runtime.__moyaOldFormalObserved = false;
    const observeOldFormal = () => {
      if (
        document.documentElement?.hasAttribute("data-formal-root") === true ||
        document.querySelector("[data-mobile-app]") !== null
      ) {
        runtime.__moyaOldFormalObserved = true;
      }
    };
    observeOldFormal();
    new MutationObserver(observeOldFormal).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  });

  const { shell, surface } = await openFormalRoot(page);
  await expect(shell).toHaveAttribute(
    "data-platform",
    expectedInitialPlatform(testInfo.project.name),
  );
  // pc-browse-only-v1: a wide visitor without an account keeps header Search
  // but has neither the dock nor 消息; narrower screens keep both.
  const wide = wideAnonymous(testInfo.project.name);
  await expectBrowseOnly(page, wide);
  await expect(
    surface.getByRole("button", { exact: true, name: "打开搜索" }),
  ).toBeVisible();
  if (wide) {
    await expect(
      surface.locator("[data-live-message-trigger]").filter({ visible: true }),
    ).toHaveCount(0);
    await expect(
      surface.locator("[data-message-trigger-hidden]").first(),
    ).toBeAttached();
  }
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __moyaOldFormalObserved?: boolean })
          .__moyaOldFormalObserved,
    ),
  ).toBe(false);
  expect(hydrationErrors).toEqual([]);
  await expect(page.locator('html[data-formal-root="true"]')).toHaveCount(0);
  await expect(page.locator("[data-mobile-app]")).toHaveCount(0);
  await expect(
    surface.locator(
      [
        "[data-qa-controls]",
        "[data-t02p-qa-harness]",
        "[data-development-primary-pager]",
        '[data-catalog-id^="qa-"]',
        '[data-media-id^="qa-"]',
      ].join(", "),
    ),
  ).toHaveCount(0);
  await expect(
    surface.locator(
      'input[type="search"], [role="search"], [data-calligraphy-filter]',
    ),
  ).toHaveCount(0);
});

test("Formal root composes truthful runtime list states", async ({
  page,
}, testInfo) => {
  // The shared anonymous fixture normally returns healthy empty lists. Keep
  // this failure-state journey explicit rather than relying on a missing route.
  let topicsUnavailable = true;
  await page.route("**/api/community/editorial/articles?*", async (route) => {
    if (
      topicsUnavailable &&
      new URL(route.request().url()).searchParams.get("presentation") ===
        "academic"
    ) {
      await route.fulfill({ status: 503 });
    } else {
      await route.continue();
    }
  });
  const { shell } = await openFormalRoot(page);
  const home = shell.locator("[data-home-surface]");
  const multiMediaCard = home.locator(
    `[data-home-feed-panel="discover"] [data-catalog-id="${runtimeIds.multiMedia}"]`,
  );
  await expect(multiMediaCard).toContainText("运行时多图碑刻");
  // unified-media-pipeline-v1: the card offers its candidates up to the
  // anchor, which stays its src, and the browser loads a real WebP from them.
  // A phone single-column post shows its whole gallery; the first image is
  // the card image.
  const cardImage = multiMediaCard.locator("img").first();
  await expect(cardImage).toHaveAttribute("srcset", /1200w$/u);
  const [src, srcset] = await Promise.all([
    cardImage.getAttribute("src"),
    cardImage.getAttribute("srcset"),
  ]);
  expect(src).toMatch(
    /\/media\/renditions\/inscription-front-card-1200x1600\.webp$/u,
  );
  expect(srcset?.split(", ").map((entry) => entry.split(" ")[1])).toEqual([
    "360w",
    "810w",
    "1200w",
  ]);
  expect(srcset).toContain(`${src} 1200w`);
  await expect
    .poll(() =>
      cardImage.evaluate(
        (image) =>
          (image as HTMLImageElement).complete &&
          (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(home.locator('[data-home-feed-panel="nearby"]')).toContainText(
    "附近内容尚未接入",
  );
  // pc-browse-only-v1: a wide visitor without an account has no 讨论. Below
  // the wide width the dock returns, so the 讨论 states are read there.
  const wide = wideAnonymous(testInfo.project.name);
  if (wide) {
    await expectBrowseOnly(page, true);
    await page.setViewportSize(narrowViewport);
    await expectBrowseOnly(page, false);
  }
  await selectPrimaryDestination(page, "讨论", "discussion");
  const discussion = shell.locator("[data-discussion-surface]");
  const topicsTab = discussion.getByRole("tab", { exact: true, name: "专题" });
  await expect(topicsTab).toBeVisible();
  await topicsTab.click();
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(
    discussion.getByRole("tabpanel", { name: "专题" }),
  ).toContainText("专题暂时不可用");
  topicsUnavailable = false;
  const retry = discussion
    .getByRole("tabpanel", { name: "专题" })
    .getByRole("button", { name: "重试" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(
    discussion.getByRole("tabpanel", { name: "专题" }),
  ).toContainText("暂无专题");
  if (wide) {
    // Back at the wide width, browse-only returns 讨论 to Home at runtime.
    await restoreProjectViewport(page, testInfo);
    await expect(shell).toHaveAttribute("data-active-destination", "home");
    await expectBrowseOnly(page, true);
  }

  // The existing inscription sequence loads when its Home tab becomes active.
  await selectHomeFeed(page, "碑刻", "inscriptions");
  await expect(
    home.locator(
      `[data-home-feed-panel="inscriptions"] [data-catalog-id="${runtimeIds.noMedia}"]`,
    ),
  ).toContainText("运行时无图碑刻");

  await selectHomeFeed(page, "书帖", "calligraphy");
  const calligraphy = home.locator('[data-home-feed-panel="calligraphy"]');
  await expect(
    calligraphy.locator(
      `[data-calligraphy-all] [data-catalog-id="${runtimeIds.calligraphy}"]`,
    ),
  ).toContainText("运行时书帖");
  await expect(calligraphy.getByRole("tablist")).toHaveCount(0);
  await expect(
    calligraphy.locator("[data-calligraphy-category-panel]"),
  ).toHaveCount(0);
  await expect(calligraphy).not.toContainText("视觉 QA 合成");
});

test("Formal Home, Inscriptions, and Calligraphy reuse one Detail and Viewer journey", async ({
  page,
}, testInfo) => {
  const { shell } = await openFormalRoot(page);
  const detail = detailDialog(page);
  const back = detail.getByRole("button", { exact: true, name: "返回" });
  // pc-browse-only-v1: wide cards still open Detail and take focus back, but
  // the Detail reads without comments or actions.
  const wide = wideAnonymous(testInfo.project.name);
  await expectBrowseOnly(page, wide);

  const openAndReturn = async (catalogId: string, title: string) => {
    const opener = activeCatalogOpener(shell, catalogId);
    await expect(opener).toBeVisible();
    await Promise.all([
      page.waitForURL((url) => isFormalDetailUrl(url, catalogId), {
        timeout: 10_000,
      }),
      opener.click(),
    ]);
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute("data-detail-source", "runtime");
    await expect(detail.locator("[data-detail-title]")).toHaveText(title);
    if (wide) await expectBrowseOnlyDetail(detail);
    await expect(back).toBeVisible();
    await Promise.all([
      page.waitForURL(isFormalPrimaryUrl, { timeout: 10_000 }),
      back.click(),
    ]);
    await expect(detail).toHaveCount(0);
    await expect(opener).toBeFocused();
  };

  await openAndReturn(runtimeIds.noMedia, "运行时无图碑刻");

  await selectHomeFeed(page, "碑刻", "inscriptions");
  const inscriptionsOpener = activeCatalogOpener(shell, runtimeIds.multiMedia);
  await expect(inscriptionsOpener).toBeVisible();
  await Promise.all([
    page.waitForURL((url) => isFormalDetailUrl(url, runtimeIds.multiMedia), {
      timeout: 10_000,
    }),
    inscriptionsOpener.click(),
  ]);
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-detail-title]")).toHaveText(
    "运行时多图碑刻",
  );
  if (wide) await expectBrowseOnlyDetail(detail);
  const mainImage = detail.locator(
    "[data-detail-main-image], [data-feed-slide][aria-hidden=false] img",
  );
  await expect(mainImage).toBeVisible();
  await Promise.all([
    page.waitForURL(
      (url) =>
        isFormalViewerUrl(
          url,
          runtimeIds.multiMedia,
          "runtime-inscription-front",
        ),
      { timeout: 10_000 },
    ),
    mainImage.click(),
  ]);
  const viewer = viewerDialog(page);
  await expect(viewer).toBeVisible();
  await Promise.all([
    page.waitForURL((url) => isFormalDetailUrl(url, runtimeIds.multiMedia), {
      timeout: 10_000,
    }),
    page.keyboard.press("Escape"),
  ]);
  await expect(viewer).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(back).toBeVisible();
  await Promise.all([
    page.waitForURL(isFormalPrimaryUrl, { timeout: 10_000 }),
    back.click(),
  ]);
  await expect(detail).toHaveCount(0);
  await expect(inscriptionsOpener).toBeFocused();

  await selectHomeFeed(page, "书帖", "calligraphy");
  await openAndReturn(runtimeIds.calligraphy, "运行时书帖");
});

test("Formal query Detail and Viewer preserve Back, Forward, and reload", async ({
  page,
}) => {
  await openFormalRoot(page, `/?catalogId=${runtimeIds.multiMedia}`);
  const detail = detailDialog(page);
  const viewer = viewerDialog(page);
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-detail-title]")).toHaveText(
    "运行时多图碑刻",
  );
  // Rendition peers stay mounted for Viewer paging, but a closed Viewer must
  // not compete with the carousel by downloading their display anchors.
  await expect(
    productShell(page)
      .getByRole("dialog", { name: "图像查看", includeHidden: true })
      .locator('img[alt="运行时多图碑刻局部"]'),
  ).not.toHaveAttribute("src");

  const queryMainImage = detail.locator(
    "[data-detail-main-image], [data-feed-slide][aria-hidden=false] img",
  );
  await expect(queryMainImage).toBeVisible();
  await queryMainImage.click();
  await expect(viewer).toBeVisible();
  await expect(page).toHaveURL(/image=runtime-inscription-front/u);

  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]image=/u);

  await page.goForward();
  await expect(viewer).toBeVisible();
  await page.reload();
  await expect(viewer).toBeVisible();
  await expect(detail).toBeVisible();

  await openFormalRoot(
    page,
    `/?catalogId=${runtimeIds.multiMedia}&image=runtime-inscription-detail`,
  );
  await expect(viewerDialog(page)).toBeVisible();
  const viewerImage = viewerDialog(page).locator("[data-detail-viewer-image]");
  await expect(viewerImage).toHaveAttribute("alt", "运行时多图碑刻局部");
  // unified-media-pipeline-v1 (CW14): the Viewer opens on the fixture
  // candidate covering its fitted width, names its width, and the browser
  // shows exactly that WebP.
  await expect(viewerImage).toHaveAttribute(
    "data-detail-viewer-rendition-width",
    /^(?:480|1080|1600|3200)$/u,
  );
  await expect
    .poll(() =>
      viewerImage.evaluate((node) => {
        const image = node as HTMLImageElement;
        const width = Number(
          image.getAttribute("data-detail-viewer-rendition-width"),
        );
        return (
          image.complete &&
          image.naturalWidth === width &&
          new RegExp(
            `/media/renditions/inscription-detail-${width}x\\d+\\.webp$`,
            "u",
          ).test(image.currentSrc)
        );
      }),
    )
    .toBe(true);
});

test("Catalog redirect remains 307 and Formal Detail failures stay truthful", async ({
  page,
  request,
}) => {
  const redirect = await request.get(`/catalog/${runtimeIds.multiMedia}`, {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(307);
  const location = redirect.headers().location;
  expect(location).toBeDefined();
  // Relative, so the browser keeps the public host it used (never the proxy's).
  expect(location!.startsWith("/")).toBe(true);
  const destination = new URL(location!, redirect.url());
  expect(destination.pathname).toBe("/");
  expect(destination.searchParams.get("catalogId")).toBe(runtimeIds.multiMedia);
  expect(destination.hash).toBe(`#detail-${runtimeIds.multiMedia}`);

  await openFormalRoot(page, `/catalog/${runtimeIds.multiMedia}`);
  await expect(detailDialog(page).locator("[data-detail-title]")).toHaveText(
    "运行时多图碑刻",
  );

  await openFormalRoot(page, `/?catalogId=${runtimeIds.noMedia}`);
  await expect(
    detailDialog(page).locator('[data-detail-media-state="missing"]'),
  ).toBeVisible();
  await expect(detailDialog(page)).toContainText("暂无公开图像");

  await page.route(`**/api/catalog/${runtimeIds.multiMedia}`, async (route) =>
    route.fulfill({ status: 503 }),
  );
  await openFormalRoot(page, `/?catalogId=${runtimeIds.multiMedia}`);
  await expect(detailDialog(page)).toContainText("暂时无法加载资料");
  await page.unroute(`**/api/catalog/${runtimeIds.multiMedia}`);

  await openFormalRoot(page, `/?catalogId=${runtimeIds.mismatch}`);
  await expect(detailDialog(page)).toContainText("暂时无法显示此页面");
  await expect(detailDialog(page)).not.toContainText("错误替代资源");
});

test("Wide visitors without an account only browse; narrower screens keep the dock", async ({
  page,
}, testInfo) => {
  if (!wideAnonymous(testInfo.project.name)) {
    await openFormalRoot(page);
    await expectBrowseOnly(page, false);
    return;
  }
  // pc-browse-only-v1: profile, editor and 讨论 links are dropped at mount and
  // leave a plain Home. Each target changes the path or query, so every visit
  // is a full document load rather than a same-document hash change.
  const shell = productShell(page);
  for (const target of [
    "/#editor",
    `/?authorId=user-${sampleHex}#profile`,
    `/?topic=thread-${sampleHex}`,
  ]) {
    await openFormalRoot(page, target);
    await page.waitForURL(isPlainHomeUrl, { timeout: 10_000 });
    await expectBrowseOnly(page, true);
    await expect(shell).toHaveAttribute("data-active-destination", "home");
    await expect(shell).toHaveAttribute("data-editor-open", "false");
    await expect(shell).toHaveAttribute("data-topic-open", "false");
    await expect(shell).toHaveAttribute("data-detail-open", "false");
    await expect(page.locator("[data-author-profile]")).toHaveCount(0);
  }

  // A card has no long-press menu: a held mouse press shows nothing, and its
  // release is an ordinary click that opens Detail.
  const opener = activeCatalogOpener(shell, runtimeIds.noMedia);
  await expect(opener).toBeVisible();
  await expect(
    shell.locator('[data-home-surface] [data-quick-actions="enabled"]'),
  ).toHaveCount(0);
  await opener.hover();
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
  await expect(shell).toHaveAttribute("data-detail-open", "false");
  await Promise.all([
    page.waitForURL((url) => isFormalDetailUrl(url, runtimeIds.noMedia), {
      timeout: 10_000,
    }),
    page.mouse.up(),
  ]);
  await expect(detailDialog(page)).toBeVisible();
  await expect(detailDialog(page).locator("[data-detail-title]")).toHaveText(
    "运行时无图碑刻",
  );
});

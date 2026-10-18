import { expect, test } from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

import type { Locator, Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.home-feed-layout.v2", "double"),
  );
});

// Wide-screen browse-only for visitors without an account (pc-browse-only-v1),
// full regression. The fixture issues no session cookie, so every page here is
// anonymous to the server unless a test adds one.
const wideProjects = new Set([
  "desktop-chromium",
  "desktop-webkit",
  "tablet-landscape-webkit",
]);
const narrowProject =
  "Browse-only needs the wide layout (>= 896 px on a desktop or tablet); this project stays narrow, and tablet-landscape-webkit covers the iPad UA at width.";

const noMediaId = "runtime-inscription-no-media";
const noMediaTitle = "运行时无图碑刻";

// Below the 896 px wide layout: a desktop UA presents as a tablet, an iPad UA
// stays a tablet.
const narrowWidth = 800;

const viewer = {
  id: `user-${"8".repeat(32)}`,
  handle: "synthetic-wide-viewer",
  displayName: "宽屏浏览测试",
};

const authProbe = "wide-browse-only:auth-page";

const productShell = (page: Page) => page.locator("[data-product-shell]");

const primaryNavigation = (page: Page) =>
  page.getByRole("navigation", { name: "主要内容" });

const detailDialog = (page: Page) =>
  productShell(page).getByRole("dialog", { name: "资料详情" });

const isNoMediaDetailUrl = (url: URL) =>
  url.pathname === "/" && url.searchParams.get("catalogId") === noMediaId;

const openFormalRoot = async (page: Page, target: string) => {
  const response = await page.goto(target);
  expect(response?.status()).toBe(200);
  const shell = productShell(page);
  await expect(shell).toBeVisible();
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  return shell;
};

const viewportSizes = (page: Page) => {
  const original = page.viewportSize();
  if (!original) throw new Error("Every e2e project sets a viewport");
  return {
    original,
    narrow: { width: narrowWidth, height: original.height },
  };
};

const expectReadOnlyDetail = async (shell: Locator, detail: Locator) => {
  await expect(shell).toHaveAttribute("data-browse-only", "true");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  await expect(detail.locator("[data-detail-title]")).toHaveText(noMediaTitle);
  await expect(detail.locator("[data-comment-section]")).toHaveCount(0);
  await expect(detail.locator("[data-detail-landscape-comments]")).toHaveCount(
    0,
  );
  await expect(detail.locator("[data-detail-content-actions]")).toHaveCount(0);
};

/**
 * Runs in every document before its own scripts. On /login or /register it
 * records, in this tab's sessionStorage (which outlives the redirect), that the
 * auth document was served, the redirect marker the inline script set, and
 * whether the auth page ever reached a frame while visible.
 */
const recordAuthPagePaint = (probe: string) => {
  const path = window.location.pathname;
  if (path !== "/login" && path !== "/register") return;
  const record = (field: string, value: string) => {
    try {
      window.sessionStorage.setItem(`${probe}:${path}:${field}`, value);
    } catch {
      // Without storage the probe reads empty and the assertion fails.
    }
  };
  record("served", "true");
  // Init scripts can run before <html> exists: watch the document itself.
  const readMarker = () => {
    const marker = document.documentElement?.dataset.authRedirect;
    if (marker !== undefined) record("redirect", marker);
  };
  new MutationObserver(readMarker).observe(document, {
    attributes: true,
    attributeFilter: ["data-auth-redirect"],
    subtree: true,
  });
  window.addEventListener("pagehide", readMarker);
  const watch = () => {
    for (const node of document.querySelectorAll(
      '[data-auth-mode], nav[aria-label="认证导航"]',
    )) {
      if (
        node.getClientRects().length > 0 &&
        window.getComputedStyle(node).visibility === "visible"
      )
        record("painted", "true");
    }
    window.requestAnimationFrame(watch);
  };
  window.requestAnimationFrame(watch);
};

const readAuthProbe = (page: Page, pathname: string) =>
  page.evaluate(
    (prefix) => ({
      served: window.sessionStorage.getItem(`${prefix}:served`),
      redirect: window.sessionStorage.getItem(`${prefix}:redirect`),
      painted: window.sessionStorage.getItem(`${prefix}:painted`),
    }),
    `${authProbe}:${pathname}`,
  );

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
  // Compile the auth pages before a page subscribes to HMR, as the support
  // helper does for the Formal routes.
  for (const path of ["/login", "/register"]) {
    const response = await request.get(path, { timeout: 0 });
    expect(response.status(), `Prepare ${path}`).toBe(200);
  }
});

test.describe("anonymous visitor", () => {
  const pageErrors = new WeakMap<Page, string[]>();

  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  });

  test.afterEach(async ({ page }) => {
    expect(pageErrors.get(page) ?? []).toEqual([]);
  });

  test("a wide screen leaves /login and /register for Home before the form paints", async ({
    page,
  }, testInfo) => {
    test.skip(!wideProjects.has(testInfo.project.name), narrowProject);
    await page.addInitScript(recordAuthPagePaint, authProbe);
    for (const [pathname, target] of [
      ["/login", "/login"],
      ["/register", "/register?return=/x"],
    ] as const) {
      await page.goto(target, { waitUntil: "commit" });
      await page.waitForURL(
        (url) => url.pathname === "/" && url.search === "",
        { timeout: 10_000, waitUntil: "commit" },
      );
      const shell = productShell(page);
      await expect(shell).toHaveAttribute("data-browse-only", "true");
      await expect(page.locator("[data-product-boot]")).toHaveCount(0);
      expect(await readAuthProbe(page, pathname)).toEqual({
        served: "true",
        redirect: "home",
        painted: null,
      });
    }
  });

  test("/login renders the sign-in form below the wide layout", async ({
    page,
  }, testInfo) => {
    if (wideProjects.has(testInfo.project.name))
      await page.setViewportSize(viewportSizes(page).narrow);
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-auth-mode="sign-in"]')).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/login");
    // The document decided once to keep the form.
    await expect(page.locator("html")).toHaveAttribute(
      "data-auth-redirect",
      "none",
    );
  });

  test("Detail reads without comments or actions when wide and regains them at 800 px", async ({
    page,
  }, testInfo) => {
    test.skip(!wideProjects.has(testInfo.project.name), narrowProject);
    const { original, narrow } = viewportSizes(page);
    const shell = await openFormalRoot(page, `/?catalogId=${noMediaId}`);
    const detail = detailDialog(page);
    await expectReadOnlyDetail(shell, detail);
    await expect(page).toHaveURL(isNoMediaDetailUrl);

    await page.setViewportSize(narrow);
    await expect(shell).toHaveAttribute("data-browse-only", "false");
    const comments = detail.locator("[data-comment-section]");
    await expect(comments).toHaveCount(1);
    // A portrait tablet pages Detail; its comments sit behind the 评论 tab.
    const pager = detail.locator("[data-detail-content-pager]");
    if ((await pager.count()) > 0) {
      const commentsTab = pager.getByRole("tab", { name: "评论" });
      await expect(commentsTab).toBeVisible();
      await commentsTab.click();
      await expect(pager).toHaveAttribute(
        "data-detail-content-active-page",
        "comments",
      );
    }
    await expect(comments).toBeVisible();
    await expect(comments).toHaveAttribute("data-comment-presentation", "live");
    await expect(detail.locator("[data-detail-content-actions]")).toBeVisible();

    await page.setViewportSize(original);
    await expectReadOnlyDetail(shell, detail);
    await expect(page).toHaveURL(isNoMediaDetailUrl);
  });

  test("a wide screen ignores ?notifications= and drops it from the URL", async ({
    page,
  }, testInfo) => {
    test.skip(!wideProjects.has(testInfo.project.name), narrowProject);
    const shell = await openFormalRoot(page, "/?notifications=comments");
    await expect(shell).toHaveAttribute("data-browse-only", "true");
    await expect(page).toHaveURL(
      (url) => url.pathname === "/" && !url.searchParams.has("notifications"),
    );
    await expect(
      page.locator("[data-primary-navigation-layer]"),
    ).toHaveAttribute("hidden");
    await expect(
      page.getByRole("button", { name: "打开搜索", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("[data-message-trigger-hidden]").first(),
    ).toBeAttached();
    await expect(page.locator("[data-live-message-trigger]")).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: /^(消息|评论)$/u }),
    ).toHaveCount(0);
  });
});

test("a signed-in wide screen keeps the dock, 消息 and Detail actions", async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(!wideProjects.has(testInfo.project.name), narrowProject);
  if (!baseURL) throw new Error("The e2e config sets baseURL");
  // A real signed-in browser carries the cookie; /me confirms the viewer.
  await addSessionCookie(context, baseURL);
  await page.route("**/api/community/**", (route) =>
    new URL(route.request().url()).pathname === "/api/community/me"
      ? route.fulfill({ json: viewer })
      : route.continue(),
  );
  const shell = await openFormalRoot(page, "/");
  await expect(shell).toHaveAttribute("data-browse-only", "false");
  await expect(primaryNavigation(page)).toBeVisible();
  await expect(page.locator("[data-message-trigger-hidden]")).toHaveCount(0);

  const opener = shell
    .locator(
      '[data-primary-destination="home"] [data-home-feed-panel][aria-hidden="false"]',
    )
    .locator(`[data-catalog-id="${noMediaId}"] [data-open-catalog]`);
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(page).toHaveURL(isNoMediaDetailUrl);
  const detail = detailDialog(page);
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  await expect(detail.locator("[data-detail-title]")).toHaveText(noMediaTitle);
  await expect(detail.locator("[data-detail-content-actions]")).toBeVisible();
  await expect(detail.locator("[data-comment-section]")).toBeVisible();
  await expect(shell).toHaveAttribute("data-browse-only", "false");
});

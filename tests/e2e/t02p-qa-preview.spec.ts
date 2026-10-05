import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { expect, test } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

const pageErrors = new WeakMap<Page, string[]>();

const observePageErrors = (page: Page, errors: string[]) => {
  page.on("pageerror", (error) => {
    errors.push(`${page.url()}\n${error.stack ?? error.message}`);
  });
};

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  observePageErrors(page, errors);
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = pageErrors.get(page) ?? [];
  await testInfo.attach("unfiltered-pageerrors", {
    body: JSON.stringify(errors, null, 2),
    contentType: "application/json",
  });
  expect(errors, "Every pageerror, including ResizeObserver errors").toEqual(
    [],
  );
});

const openQa = async (page: Page, query = "") => {
  const response = await page.goto(`/dev/t02p/qa${query}`);
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  const shell = surface.locator("[data-product-shell]");
  await expect(surface).toHaveCount(1);
  await expect(shell).toHaveCount(1);
  await expect(shell.locator("[data-search-trigger]")).toBeVisible();
  await expect(shell.locator("[data-user-trigger]")).toBeVisible();
  return { surface, shell };
};

const expectChrome = async (surface: Locator, mode: "visible" | "hidden") => {
  await expect(surface).toHaveAttribute("data-qa-chrome", mode);
  const controls = surface.locator("[data-qa-controls]");
  await expect(controls).toHaveCount(mode === "hidden" ? 0 : 1);
  await expect(surface.locator("[data-development-primary-pager]")).toHaveCount(
    mode === "hidden" ? 0 : 1,
  );
  if (mode === "visible") {
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("combobox")).toHaveCount(6);
  }
};

const navigateTo = async (
  shell: Locator,
  name: "首页" | "讨论" | "用户",
  destination: "home" | "discussion" | "user",
) => {
  const navigation = shell.locator("[data-primary-navigation]");
  if ((await navigation.getAttribute("data-minimized")) === "true") {
    // The existing minimized gesture expands only; perform that real action
    // explicitly before requesting a different destination.
    await navigation.locator('[data-selected="true"]').click();
    await expect(navigation).toHaveAttribute("data-minimized", "false");
  }
  await navigation.getByRole("button", { exact: true, name }).click();
  await expect(shell).toHaveAttribute("data-active-destination", destination);
};

const selectHomeFeed = async (
  shell: Locator,
  name: "发现" | "附近" | "碑刻" | "书帖",
  feed: "discover" | "nearby" | "inscriptions" | "calligraphy",
) => {
  await navigateTo(shell, "首页", "home");
  const home = shell.locator("[data-home-surface]");
  const tab = home.getByRole("tab", { exact: true, name });
  if (await shell.page().locator("[data-qa-controls]").count()) {
    // Normal QA chrome intentionally covers the top tabs on narrow screens.
    // Use their real keyboard activation without altering or hiding that chrome.
    await tab.focus();
    await tab.press("Enter");
  } else await tab.click();
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
  await expect(
    home.locator(`[data-home-feed-panel="${feed}"]`),
  ).toHaveAttribute("aria-hidden", "false");
};

const activeCatalogCards = (shell: Locator) =>
  shell.locator(
    '[data-primary-destination="home"]:not([hidden]) [data-home-feed-panel][aria-hidden="false"] :is([data-catalog-card], [data-content-type="catalog"])',
  );

const catalogSnapshot = async (shell: Locator, settleMedia = true) => {
  const cards = activeCatalogCards(shell);
  // Formal discovery reads populate after the selected feed commits.
  await expect.poll(() => cards.count()).toBeGreaterThan(0);
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  if (settleMedia) {
    for (let index = 0; index < count; index += 1) {
      await cards.nth(index).scrollIntoViewIfNeeded();
    }
    const media = cards.locator("[data-catalog-media-state]");
    await expect(media).toHaveCount(count);
    await expect
      .poll(() =>
        media.evaluateAll((nodes) =>
          nodes.every((node) => {
            const state = (node as HTMLElement).dataset.catalogMediaState;
            if (state === "failed" || state === "missing") return true;
            const image = node.querySelector("img");
            return image?.complete === true && image.naturalWidth > 0;
          }),
        ),
      )
      .toBe(true);
  }
  return cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: (node as HTMLElement).dataset.catalogId,
      kind: (node as HTMLElement).dataset.catalogKind,
      mediaState: node
        .querySelector("[data-catalog-media-state]")
        ?.getAttribute("data-catalog-media-state"),
      media: Array.from(node.querySelectorAll("img"), (image) => ({
        alt: image.alt,
        src: image.getAttribute("src"),
      })),
      text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
};

const qaCatalogs = async (shell: Locator) => {
  await selectHomeFeed(shell, "碑刻", "inscriptions");
  const inscriptions = await catalogSnapshot(shell);
  expect(
    inscriptions.find(({ id }) => id === "qa-visual-inscription-12")
      ?.mediaState,
  ).toBe("failed");
  await selectHomeFeed(shell, "书帖", "calligraphy");
  const allCalligraphy = shell.locator('[data-home-feed-panel="calligraphy"]');
  await expect(allCalligraphy.locator("[data-calligraphy-all]")).toBeVisible();
  await expect(allCalligraphy.getByRole("tablist")).toHaveCount(0);
  await expect(
    allCalligraphy.locator("[data-calligraphy-category-panel]"),
  ).toHaveCount(0);
  const calligraphy = await catalogSnapshot(shell);
  expect(calligraphy).toHaveLength(12);
  await selectHomeFeed(shell, "碑刻", "inscriptions");
  return { inscriptions, calligraphy };
};

test("QA chrome uses only its URL mode and hidden mode survives reload and a copied link", async ({
  page,
  context,
}) => {
  let initialDock:
    { x: number; y: number; width: number; height: number } | undefined;
  for (const [query, mode] of [
    ["", "visible"],
    ["?qaChrome=hidden", "hidden"],
    ["?qaChrome=unsupported", "visible"],
    ["?qaChrome=Hidden", "visible"],
    ["?qaChrome=hidden&qaChrome=hidden", "visible"],
  ] as const) {
    const { surface, shell } = await openQa(page, query);
    await expectChrome(surface, mode);
    await expect(shell.locator("[data-primary-navigation]")).toHaveCount(1);
    await expect(
      shell.locator("[data-primary-navigation-destination]"),
    ).toHaveCount(3);
    const dock = await shell
      .locator("[data-primary-navigation-dock]")
      .boundingBox();
    if (dock === null) throw new Error("Missing product navigation geometry");
    if (initialDock === undefined) initialDock = dock;
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(dock[dimension] - initialDock[dimension]),
      ).toBeLessThanOrEqual(1);
    }
    await expect(shell.locator("[data-open-settings]")).toHaveCount(0);
  }

  const { surface } = await openQa(page, "?qaChrome=hidden");
  const copiedUrl = page.url();
  expect((await page.reload())?.status()).toBe(200);
  await expectChrome(surface, "hidden");
  const copiedPage = await context.newPage();
  observePageErrors(copiedPage, pageErrors.get(page)!);
  try {
    expect((await copiedPage.goto(copiedUrl))?.status()).toBe(200);
    await expectChrome(copiedPage.locator("[data-t02p-qa-harness]"), "hidden");
    const ordinary = await openQa(copiedPage);
    await expectChrome(ordinary.surface, "visible");
  } finally {
    await copiedPage.close();
  }
});

test("hidden QA keeps Catalog identity and the existing Search Filter User Settings owners", async ({
  page,
}, testInfo) => {
  const normal = await openQa(page);
  const normalPlatform = await normal.shell.getAttribute("data-platform");
  const normalCatalogs = await qaCatalogs(normal.shell);
  const hidden = await openQa(page, "?qaChrome=hidden");
  await expectChrome(hidden.surface, "hidden");
  await expect(hidden.shell).toHaveAttribute(
    "data-platform",
    normalPlatform ?? "",
  );
  expect(await qaCatalogs(hidden.shell)).toEqual(normalCatalogs);
  const { shell } = hidden;
  const originalCards = await catalogSnapshot(shell, false);
  const source = shell.locator('[data-home-feed-panel="inscriptions"]');
  // ProductShell restores a destination over two animation frames. The initial
  // WebKit probe captured 225 before that existing restore reached 990, before
  // any Filter click in all three controls. Measure a settled pre-action source.
  const sourceSamples = await source.evaluate(async (node) => {
    const samples = [];
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      samples.push({ panel: node.scrollTop, document: window.scrollY });
    }
    return samples;
  });
  await testInfo.attach("pre-utility-source-scroll-frames", {
    body: JSON.stringify(sourceSamples, null, 2),
    contentType: "application/json",
  });
  const sourceScroll = sourceSamples.at(-1)!;
  for (const sample of sourceSamples.slice(-3))
    expect(sample).toEqual(sourceScroll);

  const filter = shell.locator("[data-inscription-filter]");
  await filter.locator("[data-filter-trigger]").click();
  await expect(filter.locator("[data-filter-panel]")).toBeVisible();
  await filter.getByRole("button", { name: "关闭筛选" }).click();
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);

  const searchTrigger = shell.locator("[data-search-trigger]");
  const userTrigger = shell.locator("[data-user-trigger]");
  await searchTrigger.click();
  const search = shell.getByRole("dialog", { name: "QA 搜索" });
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute("aria-modal", "true");
  await expect(userTrigger).toHaveAttribute("inert", "");
  await expect(shell.locator("[data-primary-navigation-dock]")).toHaveAttribute(
    "inert",
    "",
  );
  const input = search.getByRole("searchbox", { name: "搜索关键词" });
  await expect(input).toBeFocused();
  await input.fill("  龙门石窟  ");
  // Existing keyboard submission keeps the unmodified development indicator
  // present; this case does not claim physical-keyboard or magnifier hit testing.
  await input.press("Enter");
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录搜索意图：龙门石窟",
  );
  expect(await catalogSnapshot(shell, false)).toEqual(originalCards);
  await expect(
    shell.locator("[data-user-page], [data-filter-panel]"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(searchTrigger).toBeFocused();

  await userTrigger.click();
  const userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await expect(
    shell.locator("[data-search-panel], [data-filter-panel]"),
  ).toHaveCount(0);
  await expect(userPage.locator("[data-user-panel]")).toHaveCount(4);
  await expect(userPage.getByRole("tab", { name: "发布" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const settingsEntry = userPage.getByRole("button", { name: "打开设置" });
  await settingsEntry.click();
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "返回" })).toBeFocused();
  await expect(shell.locator("[data-product-primary-layer]")).toHaveAttribute(
    "inert",
    "",
  );
  await settings.getByRole("button", { name: "返回" }).click();
  await expect(settings).toHaveCount(0);
  await expect(userPage).toBeVisible();
  await expect(settingsEntry).toBeFocused();
  await userPage.getByRole("button", { name: "关闭用户页" }).click();
  await expect(userPage).toHaveCount(0);
  await expect(userTrigger).toBeFocused();
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );
  await expect
    .poll(() =>
      source.evaluate((node) => ({
        panel: node.scrollTop,
        document: window.scrollY,
      })),
    )
    .toEqual(sourceScroll);
  expect(await catalogSnapshot(shell, false)).toEqual(originalCards);
});

test("hidden QA preserves existing scenario feed and topic entry parameters", async ({
  page,
}) => {
  const { surface, shell } = await openQa(
    page,
    "?qaChrome=hidden&scenario=nearby-demo&feed=nearby",
  );
  await expectChrome(surface, "hidden");
  await expect(surface).toHaveAttribute("data-home-scenario", "nearby-demo");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "nearby",
  );
  expect((await page.reload())?.status()).toBe(200);
  await expectChrome(surface, "hidden");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "nearby",
  );

  const topicEntries = [];
  for (const mode of ["visible", "hidden"] as const) {
    const response = await page.goto(
      `/dev/t02p/qa?${mode === "hidden" ? "qaChrome=hidden&" : ""}scenario=topics-editorial&feed=topics&topic=topic-cliff-paths`,
    );
    expect(response?.status()).toBe(200);
    await expectChrome(surface, mode);
    await expect(surface).toHaveAttribute(
      "data-home-scenario",
      "topics-editorial",
    );
    await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
      "data-active-home-feed",
      "discover",
    );
    await expect(shell).toHaveAttribute(
      "data-active-destination",
      "discussion",
    );
    const discussion = shell.locator("[data-discussion-surface]");
    await expect(discussion).toHaveAttribute(
      "data-active-discussion-feed",
      "topics",
    );
    const topic = shell.getByRole("dialog", { name: "专题：摩崖之路" });
    await expect(topic).toBeVisible();
    // The legacy feed=topics parameter falls back to Home Discover; the explicit
    // topic parameter opens its Discussion owner in both QA chrome modes.
    topicEntries.push(
      await shell.evaluate(async (node) => {
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        }
        return {
          topicOpen: node.getAttribute("data-topic-open"),
          topicIds: Array.from(
            node.querySelectorAll("[data-topic-id]"),
            (card) => card.getAttribute("data-topic-id"),
          ),
          dialogs: Array.from(
            node.querySelectorAll('[role="dialog"]'),
            (dialog) => dialog.getAttribute("aria-label"),
          ),
        };
      }),
    );
    await topic.getByRole("button", { name: "返回专题" }).click();
    await expect(topic).toHaveCount(0);
    // Keyboard activation is a real existing action and is not blocked by the
    // normal QA aside covering the first card's pointer coordinates.
    const card = discussion.locator(
      '[role="tabpanel"][aria-hidden="false"] [data-topic-id="topic-cliff-paths"]',
    );
    await expect(card).toHaveCount(1);
    await card.focus();
    await card.press("Enter");
    await expect(topic).toBeVisible();
    await topic.getByRole("button", { name: "返回专题" }).click();
    await expect(topic).toHaveCount(0);
    await expect(card).toBeFocused();
    await expect(shell).toHaveAttribute(
      "data-active-destination",
      "discussion",
    );
    await expect(discussion).toHaveAttribute(
      "data-active-discussion-feed",
      "topics",
    );
    expect(new URL(page.url()).searchParams.get("topic")).toBe(
      "topic-cliff-paths",
    );
  }
  expect(topicEntries[1]).toEqual(topicEntries[0]);
});

test("Formal and clean Development do not consume the QA chrome parameter", async ({
  page,
}) => {
  const paths = ["/", "/dev/t02p"] as const;
  const queries = ["", "?qaChrome=hidden"] as const;

  // Compile both development routes before a browser page subscribes to HMR.
  // Otherwise the first /dev/t02p compilation can reload the previous route in
  // WebKit and interrupt the next navigation rather than testing query isolation.
  for (const path of paths) {
    for (const query of queries) {
      expect((await page.request.get(`${path}${query}`)).status()).toBe(200);
    }
  }

  for (const path of paths) {
    const snapshots = [];
    for (const query of queries) {
      expect((await page.goto(`${path}${query}`))?.status()).toBe(200);
      await expect(
        page.locator(
          "[data-t02p-qa-harness], [data-qa-controls], [data-qa-chrome]",
        ),
      ).toHaveCount(0);
      await expect(
        page.locator(
          "[data-inscription-filter]:has([data-filter-trigger]), [data-user-trigger], [data-open-settings]",
        ),
      ).toHaveCount(0);
      await expect(
        page.locator("details[data-inscription-filter]"),
      ).toHaveCount(path === "/" ? 1 : 0);
      await expect(page.locator("[data-search-trigger]")).toHaveCount(
        path === "/" ? 3 : 0,
      );
      await expect(
        page.locator('[data-search-trigger-placement="header"]'),
      ).toHaveCount(path === "/" ? 3 : 0);
      await expect(page.locator("[data-catalog-search]")).toHaveCount(
        path === "/" ? 1 : 0,
      );
      await expect(page.locator('[data-catalog-id^="qa-visual-"]')).toHaveCount(
        0,
      );
      const shell = page.locator("[data-product-shell]");
      await expect(shell).toHaveCount(1);
      await selectHomeFeed(shell, "碑刻", "inscriptions");
      snapshots.push(await catalogSnapshot(shell));
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  }
});

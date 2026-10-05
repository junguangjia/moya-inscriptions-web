import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { expect, test } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

type PresentationPlatform = "phone" | "tablet" | "pc";

const expectedPlatform = (projectName: string): PresentationPlatform => {
  if (projectName === "mobile-webkit") return "phone";
  if (projectName.startsWith("tablet")) return "tablet";
  return "pc";
};

const openQa = async (page: Page) => {
  // The disposable fixture already disables the badge before server startup.
  // Keep its supported configuration stable while testing the real submit target.
  const response = await page.goto("/dev/t02p/qa");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  const shell = surface.locator("[data-product-shell]");
  const search = shell.locator("[data-t02p-qa-search]");
  await expect(shell.locator("[data-search-trigger]")).toBeVisible();
  return { search, shell, surface };
};

const selectHomeFeed = async (
  surface: Locator,
  shell: Locator,
  label: "发现" | "附近" | "碑刻" | "书帖",
  feed: "discover" | "nearby" | "inscriptions" | "calligraphy",
) => {
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  const home = surface.locator("[data-home-surface]");
  const tab = home.getByRole("tab", { exact: true, name: label });
  if (await surface.locator("[data-qa-controls]").count()) {
    await tab.focus();
    await tab.press("Enter");
  } else await tab.click();
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
  await expect(
    home.locator(`[data-home-feed-panel="${feed}"]`),
  ).toHaveAttribute("aria-hidden", "false");
};

const visibleCatalogCards = (shell: Locator) =>
  shell.locator(
    '[data-primary-destination="home"]:not([hidden]) [data-home-feed-panel="inscriptions"][aria-hidden="false"] [data-catalog-card]',
  );

const waitForVisibleCatalogMedia = async (shell: Locator) => {
  const cards = visibleCatalogCards(shell);
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
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
  await expect(
    shell.locator(
      '[data-primary-destination="home"]:not([hidden]) [data-home-feed-panel="inscriptions"][aria-hidden="false"] [data-catalog-id="qa-visual-inscription-12"] [data-catalog-media-state="failed"]',
    ),
  ).toHaveCount(1);
};

const visibleCatalogSnapshot = async (shell: Locator, settleMedia = true) => {
  if (settleMedia) await waitForVisibleCatalogMedia(shell);
  return visibleCatalogCards(shell).evaluateAll((cards) =>
    cards.map((card) => ({
      id: (card as HTMLElement).dataset.catalogId ?? "",
      kind: (card as HTMLElement).dataset.catalogKind ?? "",
      media: Array.from(card.querySelectorAll("img")).map((image) => ({
        alt: image.alt,
        src: image.getAttribute("src") ?? "",
      })),
      text: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
};

const expectOpaqueSurface = async (surface: Locator) => {
  const colors = await surface.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      foreground: style.color,
    };
  });

  for (const value of Object.values(colors)) {
    expect(value).not.toBe("transparent");
    expect(value).not.toBe("rgba(0, 0, 0, 0)");
  }
};

const contrastRatio = (foreground: string, background: string) => {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (channels?.length !== 3) throw new Error(`Unsupported color: ${color}`);
    const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

const expectTextContrast = async (text: Locator, background: Locator) => {
  const [foregroundColor, backgroundColor] = await Promise.all([
    text.evaluate((node) => getComputedStyle(node).color),
    background.evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  expect(
    contrastRatio(foregroundColor, backgroundColor),
  ).toBeGreaterThanOrEqual(4.5);
};

test("QA Search and Filter stay isolated from Formal and clean Development", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");

  for (const path of ["/dev/t02p", "/"] as const) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("[data-t02p-qa-search]")).toHaveCount(0);
    await expect(
      page.locator("[data-inscription-filter] [data-filter-trigger]"),
    ).toHaveCount(0);
    await expect(page.locator("[data-search-trigger]")).toHaveCount(
      path === "/" ? 3 : 0,
    );
    await expect(page.locator("[data-catalog-search]")).toHaveCount(
      path === "/" ? 1 : 0,
    );
    await expect(page.locator("[data-open-settings]")).toHaveCount(0);
  }

  const { search, shell } = await openQa(page);
  await expect(search).toHaveCount(1);
  await expect(shell.locator("[data-search-trigger]")).toBeVisible();
  await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);
});

test("Search remains global while Filter follows the Home Inscriptions feed", async ({
  page,
}) => {
  const { search, shell, surface } = await openQa(page);

  for (const [label, feed, filterVisible] of [
    ["发现", "discover", false],
    ["附近", "nearby", false],
    ["碑刻", "inscriptions", true],
    ["书帖", "calligraphy", false],
  ] as const) {
    await selectHomeFeed(surface, shell, label, feed);
    await expect(search).toHaveCount(1);
    await expect(shell.locator("[data-search-trigger]")).toBeVisible();
    await expect(shell.locator("[data-inscription-filter]")).toHaveCount(
      filterVisible ? 1 : 0,
    );
  }

  const navigation = surface.getByRole("navigation", { name: "主要内容" });
  for (const [label, destination] of [
    ["讨论", "discussion"],
    ["用户", "user"],
    ["首页", "home"],
  ] as const) {
    await navigation.getByRole("button", { name: label, exact: true }).click();
    await expect(shell).toHaveAttribute("data-active-destination", destination);
    await expect(search).toHaveCount(1);
    await expect(shell.locator("[data-search-trigger]")).toBeVisible();
    await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);
  }
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "calligraphy",
  );
});

test("search intents preserve Catalog identity, data and order while close actions restore focus", async ({
  page,
}, testInfo) => {
  const { search, shell, surface } = await openQa(page);
  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const initialSnapshot = await visibleCatalogSnapshot(shell);
  expect(initialSnapshot.length).toBeGreaterThan(0);

  const trigger = shell.locator("[data-search-trigger]");
  await expect(trigger).toHaveAttribute("aria-label", "打开搜索");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(search.getByText("暂无搜索记录", { exact: true })).toBeVisible();
  await expect(
    search.getByText("最近搜索会显示在这里", { exact: true }),
  ).toBeVisible();
  const input = search.getByRole("searchbox", { name: "搜索关键词" });
  await expect(input).toBeFocused();
  await input.fill("  龙门石窟  ");
  await search.locator("[data-search-submit]").click();
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录搜索意图：龙门石窟",
  );
  expect(await visibleCatalogSnapshot(shell, false)).toEqual(initialSnapshot);

  await input.fill("");
  await expect(input).toHaveValue("");
  await expect(search.getByText("暂无搜索记录", { exact: true })).toBeVisible();
  await input.fill("龙门");
  await search.locator('[data-search-suggestion="龙门石窟"]').click();
  await expect(input).toHaveValue("龙门石窟");
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录建议意图：龙门石窟",
  );
  expect(await visibleCatalogSnapshot(shell, false)).toEqual(initialSnapshot);

  await search.locator("[data-search-close]").click();
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-label", "打开搜索");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await expect(shell.locator("[data-open-settings]")).toHaveCount(0);
  await expect(shell.locator("[data-user-trigger]")).toBeVisible();
  await expect(shell).toHaveAttribute(
    "data-platform",
    expectedPlatform(testInfo.project.name),
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);
});

test("the seeded empty scenario returns to ordinary suggestions after every user edit path", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { search, surface } = await openQa(page);
  const selector = surface.getByRole("combobox", {
    name: "QA Search scenario",
  });
  await selector.selectOption("search-open");
  await expect(search.getByText("QA 最近搜索", { exact: true })).toBeVisible();
  await search.locator('[data-search-suggestion="碑刻"]').click();
  await expect(
    search.getByRole("searchbox", { name: "搜索关键词" }),
  ).toHaveValue("碑刻");
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录建议意图：碑刻",
  );

  const seedEmptyScenario = async () => {
    if ((await search.locator("[data-search-panel]").count()) === 1) {
      await search.locator("[data-search-close]").click();
    }
    await selector.selectOption("search-default");
    await expect(search.locator("[data-search-panel]")).toHaveCount(0);
    await selector.selectOption("search-empty");
    await expect(search.locator("[data-search-empty]")).toBeVisible();
    const input = search.getByRole("searchbox", { name: "搜索关键词" });
    await expect(input).toHaveValue("未收录题刻");
    return input;
  };

  let input = await seedEmptyScenario();
  await input.fill("龙门");
  await expect(search.locator("[data-search-empty]")).toHaveCount(0);
  await expect(search.getByText("QA 搜索建议", { exact: true })).toBeVisible();

  input = await seedEmptyScenario();
  await input.fill("");
  await expect(input).toHaveValue("");
  await expect(search.locator("[data-search-empty]")).toHaveCount(0);
  await expect(search.getByText("暂无搜索记录", { exact: true })).toBeVisible();

  input = await seedEmptyScenario();
  await input.fill("龙门");
  await search.locator('[data-search-suggestion="龙门石窟"]').click();
  await expect(input).toHaveValue("龙门石窟");
  await expect(search.locator("[data-search-empty]")).toHaveCount(0);
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录建议意图：龙门石窟",
  );
});

test("keyboard utility switches keep one owner and Settings returns through User", async ({
  page,
}) => {
  const { search, shell, surface } = await openQa(page);
  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const searchTrigger = shell.locator("[data-search-trigger]");
  const filter = shell.locator("[data-inscription-filter]");
  const filterTrigger = filter.locator("[data-filter-trigger]");
  const userTrigger = shell.locator("[data-user-trigger]");

  await searchTrigger.click();
  await expect(search.locator("[data-search-panel]")).toBeVisible();
  await expect(userTrigger).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(searchTrigger).toBeFocused();
  await userTrigger.focus();
  await page.keyboard.press("Space");
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  let userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await expect(
    userPage.getByRole("button", { name: "关闭用户页" }),
  ).toBeFocused();
  await userPage.getByRole("button", { name: "关闭用户页" }).click();
  await expect(userPage).toHaveCount(0);
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(userTrigger).toBeFocused();

  await filterTrigger.click();
  await expect(filter.locator("[data-filter-panel]")).toBeVisible();
  await userTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await userPage.getByRole("button", { name: "关闭用户页" }).click();
  await expect(userPage).toHaveCount(0);
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  await expect(userTrigger).toBeFocused();

  await userTrigger.press("Enter");
  userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(
    userPage.getByRole("button", { name: "关闭用户页" }),
  ).toBeFocused();
  const userSettings = userPage.getByRole("button", { name: "打开设置" });
  await userSettings.click();
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "返回" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(userPage).toBeVisible();
  await expect(userSettings).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(userPage).toHaveCount(0);
  await expect(userTrigger).toBeFocused();
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  await expect(shell.locator("[data-open-settings]")).toHaveCount(0);

  // Fullscreen Search must close before its inert background can open User.
  await searchTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(search.locator("[data-search-panel]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(searchTrigger).toBeFocused();
  await userTrigger.focus();
  await page.keyboard.press("Enter");
  userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  const settingsTrigger = userPage.getByRole("button", { name: "打开设置" });
  await settingsTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(shell.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(
    shell.getByRole("dialog", { name: "设置" }).getByRole("button", {
      name: "返回",
    }),
  ).toBeFocused();
  await shell
    .getByRole("dialog", { name: "设置" })
    .getByRole("button", { name: "返回" })
    .click();
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(shell.getByRole("dialog", { name: "设置" })).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(settingsTrigger).toBeFocused();
  await userPage.getByRole("button", { name: "关闭用户页" }).click();
  await expect(userPage).toHaveCount(0);
  await expect(userTrigger).toBeFocused();

  await filterTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(filter.locator("[data-filter-panel]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  await expect(filterTrigger).toBeFocused();
  await userTrigger.focus();
  await page.keyboard.press("Enter");
  userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  const reopenedSettingsTrigger = userPage.getByRole("button", {
    name: "打开设置",
  });
  await reopenedSettingsTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(shell.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("all approved viewport matrices keep the three-item capsule and independent Search aligned with a fullscreen scene", async ({
  page,
}, testInfo) => {
  const matrices = {
    "desktop-chromium": [
      { height: 720, width: 1280 },
      { height: 827, width: 1512 },
      { height: 1080, width: 1920 },
    ],
    "mobile-webkit": [
      { height: 812, width: 375 },
      { height: 844, width: 390 },
      { height: 932, width: 430 },
      { height: 375, width: 812 },
      { height: 390, width: 844 },
      { height: 430, width: 932 },
    ],
    "tablet-webkit": [
      { height: 1024, width: 768 },
      { height: 1180, width: 820 },
      { height: 1112, width: 834 },
      { height: 768, width: 1024 },
      { height: 820, width: 1180 },
      { height: 834, width: 1194 },
    ],
  } as const;
  const viewports = matrices[testInfo.project.name as keyof typeof matrices];
  test.skip(viewports === undefined);
  if (viewports === undefined) return;

  const { search, shell, surface } = await openQa(page);
  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const trigger = shell.locator("[data-search-trigger]");
  const dock = shell.locator("[data-primary-navigation-dock]");
  const navigation = shell.locator("[data-primary-navigation]");
  await expect(dock).toHaveCount(1);
  await expect(navigation).toHaveCount(1);
  await expect(
    navigation.locator("[data-primary-navigation-destination]"),
  ).toHaveCount(3);
  await expect(navigation.locator("[data-search-trigger]")).toHaveCount(0);
  await expect(dock.locator("[data-search-trigger]")).toHaveCount(1);
  const filterTrigger = shell.locator("[data-filter-trigger]");
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(shell).toHaveAttribute(
      "data-platform",
      expectedPlatform(testInfo.project.name),
    );
    const navigationBox = await navigation.boundingBox();
    const searchBox = await trigger.boundingBox();
    const filterBox = await filterTrigger.boundingBox();
    if (navigationBox === null || searchBox === null || filterBox === null) {
      throw new Error(
        `Missing utility geometry at ${viewport.width}x${viewport.height}`,
      );
    }
    expect(Math.abs(navigationBox.y - searchBox.y)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(navigationBox.height - searchBox.height),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(searchBox.width - searchBox.height)).toBeLessThanOrEqual(1);
    expect(
      searchBox.x - (navigationBox.x + navigationBox.width),
    ).toBeGreaterThanOrEqual(8);
    expect(
      searchBox.x - (navigationBox.x + navigationBox.width),
    ).toBeLessThanOrEqual(12);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(viewport.width);
    expect(filterBox.x).toBeGreaterThanOrEqual(0);
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );

    await trigger.click();
    await expect(shell).toHaveAttribute("data-active-destination", "home");
    await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
      "data-active-home-feed",
      "inscriptions",
    );
    const panel = search.locator("[data-search-panel]");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(dock).toHaveAttribute("inert", "");
    const panelBox = await panel.boundingBox();
    if (panelBox === null) throw new Error("Missing search panel geometry");
    expect(Math.abs(panelBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.height - viewport.height)).toBeLessThanOrEqual(1);
    const composer = await search
      .locator("[data-search-composer]")
      .boundingBox();
    const close = await search.locator("[data-search-close]").boundingBox();
    if (composer === null || close === null)
      throw new Error("Missing composer geometry");
    expect(composer.y).toBeGreaterThan(viewport.height / 2);
    expect(composer.y + composer.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );
    expect(Math.abs(close.width - close.height)).toBeLessThanOrEqual(1);

    await search.locator("[data-search-close]").click();
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test("Search remains legible through themes and respects reduced motion", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { search, shell } = await openQa(page);
  const trigger = shell.locator("[data-search-trigger]");

  for (const preference of ["system", "light", "dark"] as const) {
    await expect(shell).toHaveAttribute("data-theme-preference", preference);
    await trigger.click();
    const panel = search.locator("[data-search-panel]");
    await expectOpaqueSurface(panel);
    await expectTextContrast(
      search.getByText("暂无搜索记录", { exact: true }),
      panel,
    );
    await search.locator("[data-search-close]").click();
    await expect(trigger).toBeFocused();

    if (preference === "dark") break;
    await shell.locator("[data-user-trigger]").click();
    const userPage = shell.getByRole("dialog", { name: "用户页" });
    await expect(
      userPage.getByRole("button", { name: "关闭用户页" }),
    ).toBeFocused();
    await userPage.getByRole("button", { name: "打开设置" }).click();
    const settings = shell.getByRole("dialog", { name: "设置" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: /切换主题/ }).click();
    await settings.getByRole("button", { name: "返回" }).click();
    await expect(settings).toHaveCount(0);
    await expect(
      userPage.getByRole("button", { name: "打开设置" }),
    ).toBeFocused();
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect
    .poll(() =>
      search
        .locator("[data-search-panel]")
        .evaluate((node) => getComputedStyle(node).animationName),
    )
    .toBe("none");
});

test("Search respects composition, trimmed submission, editing to empty, close, and source scroll", async ({
  page,
}) => {
  const { search, shell, surface } = await openQa(page);
  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  await waitForVisibleCatalogMedia(shell);
  const source = shell.locator(
    '[data-home-feed-panel="inscriptions"][aria-hidden="false"]',
  );
  const sourceScroll = await source.evaluate((node) => ({
    panel: node.scrollTop,
    window: window.scrollY,
  }));
  const trigger = shell.locator("[data-search-trigger]");
  await trigger.click();
  const panel = search.locator("[data-search-panel]");
  const input = search.getByRole("searchbox", { name: "搜索关键词" });
  await expect(input).toBeFocused();
  await input.fill("   ");
  await input.press("Enter");
  await expect(search.locator("[data-search-intent-status]")).toHaveText("");

  // This exercises browser-dispatched IME events, not a real software keyboard.
  await input.dispatchEvent("compositionstart", { data: "龙" });
  await input.fill("  龙门  ");
  await input.press("Enter");
  await expect(search.locator("[data-search-intent-status]")).toHaveText("");
  await input.dispatchEvent("compositionend", { data: "龙门" });
  await input.press("Enter");
  await expect(search.locator("[data-search-intent-status]")).toHaveText(
    "已记录搜索意图：龙门",
  );
  await expect(search.locator("[data-search-clear]")).toHaveCount(0);
  const close = search.locator("[data-search-close]");
  await expect(close).toHaveCount(1);
  await expect(close).toHaveAttribute("aria-label", "关闭搜索");
  await input.fill("");
  await expect(input).toHaveValue("");
  await expect(panel).toBeVisible();
  await expect(search.locator("[data-search-no-recent]")).toBeVisible();
  await expect(
    search.locator('[data-search-no-recent] [data-icon="search"]'),
  ).toHaveCSS("width", "50px");
  await close.focus();
  await page.keyboard.press("Tab");
  await expect(search.locator("[data-search-submit]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );
  await expect
    .poll(() =>
      source.evaluate((node) => ({
        panel: node.scrollTop,
        window: window.scrollY,
      })),
    )
    .toEqual(sourceScroll);
  await expect(
    shell.locator("[data-filter-panel], [data-user-page]"),
  ).toHaveCount(0);
});

test("dragging the primary capsule into the independent Search action never opens Search", async ({
  page,
}) => {
  const { search, shell } = await openQa(page);
  const navigation = shell.locator("[data-primary-navigation]");
  const home = await navigation
    .getByRole("button", { exact: true, name: "首页" })
    .boundingBox();
  const searchButton = await shell
    .locator("[data-search-trigger]")
    .boundingBox();
  if (home === null || searchButton === null)
    throw new Error("Missing dock controls");
  await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    searchButton.x + searchButton.width / 2,
    searchButton.y + searchButton.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(search.locator("[data-search-panel]")).toHaveCount(0);
  await expect(shell.locator("[data-search-trigger]")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(
    navigation.locator("[data-primary-navigation-destination]"),
  ).toHaveCount(3);
  const destination = await shell.getAttribute("data-active-destination");
  expect(["home", "discussion", "user"]).toContain(destination);
  await shell.locator("[data-search-trigger]").click();
  await expect(search.locator("[data-search-panel]")).toBeVisible();
  await expect(shell).toHaveAttribute(
    "data-active-destination",
    destination ?? "",
  );
});

import { expect, test } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

type PresentationPlatform = "phone" | "tablet" | "pc";
type FilterKey = "dynasty" | "script" | "inscriptionType" | "region";

const expectedPlatform = (projectName: string): PresentationPlatform => {
  if (projectName === "mobile-webkit") return "phone";
  if (projectName.startsWith("tablet")) return "tablet";
  return "pc";
};

const openQa = async (page: Page) => {
  const response = await page.goto("/dev/t02p/qa");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  const shell = surface.locator("[data-product-shell]");
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  return { shell, surface };
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

const visibleCatalogSnapshot = async (shell: Locator) => {
  await waitForVisibleCatalogMedia(shell);
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

const openQaInscriptions = async (page: Page) => {
  const { shell, surface } = await openQa(page);
  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const filter = shell.locator("[data-inscription-filter]");
  await expect(filter).toBeVisible();
  return { filter, shell, surface };
};

const openFilter = async (filter: Locator) => {
  const trigger = filter.locator("[data-filter-trigger]");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(filter.locator("[data-filter-panel]")).toBeVisible();
  return trigger;
};

const chooseFilterOption = async (
  filter: Locator,
  platform: PresentationPlatform,
  key: FilterKey,
  option: string,
) => {
  const category = filter.locator(`[data-filter-category="${key}"]`);
  await category.click();

  if (platform === "pc") {
    const popover = filter.locator(`[data-filter-popover="${key}"]`);
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { exact: true, name: option }).click();
    await expect(popover).toHaveCount(0);
  } else {
    const sheet = filter.locator(`[data-filter-sheet="${key}"]`);
    await expect(sheet).toBeVisible();
    await sheet.getByLabel(option, { exact: true }).check();
    await sheet.getByRole("button", { exact: true, name: "确定" }).click();
    await expect(sheet).toHaveCount(0);
  }

  await expect(category).toContainText(`${option} ×`);
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

const expectOwnTextContrast = async (control: Locator) => {
  const colors = await control.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, foreground: style.color };
  });
  expect(
    contrastRatio(colors.foreground, colors.background),
  ).toBeGreaterThanOrEqual(4.5);
};

test("QA filter is isolated and exists only while the Home Inscriptions feed is active", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop-chromium") {
    for (const path of ["/dev/t02p", "/"] as const) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(
        page.locator("[data-inscription-filter] [data-filter-trigger]"),
      ).toHaveCount(0);
    }
  }

  const { shell, surface } = await openQa(page);
  await expect(
    shell.locator("[data-primary-navigation-dock] [data-search-trigger]"),
  ).toBeVisible();
  await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);

  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const initialSnapshot = await visibleCatalogSnapshot(shell);
  expect(initialSnapshot.length).toBeGreaterThan(0);
  const filter = shell.locator("[data-inscription-filter]");
  await expect(filter).toBeVisible();
  await openFilter(filter);
  await chooseFilterOption(
    filter,
    expectedPlatform(testInfo.project.name),
    "dynasty",
    "隋唐",
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  await selectHomeFeed(surface, shell, "书帖", "calligraphy");
  await expect(
    shell.locator("[data-primary-navigation-dock] [data-search-trigger]"),
  ).toBeVisible();
  await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);
  await expect(page.locator("[data-filter-panel]")).toHaveCount(0);
  await expect(page.locator("[data-filter-popover]")).toHaveCount(0);
  await expect(page.locator("[data-filter-sheet]")).toHaveCount(0);

  await selectHomeFeed(surface, shell, "发现", "discover");
  await expect(
    shell.locator("[data-primary-navigation-dock] [data-search-trigger]"),
  ).toBeVisible();
  await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);

  await selectHomeFeed(surface, shell, "碑刻", "inscriptions");
  const resetFilter = shell.locator("[data-inscription-filter]");
  await expect(resetFilter).toBeVisible();
  await openFilter(resetFilter);
  await expect(
    resetFilter.locator('[data-filter-category="dynasty"]'),
  ).toContainText("朝代⌄");
  await expect(resetFilter.locator("[data-filter-reset]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  await chooseFilterOption(
    resetFilter,
    expectedPlatform(testInfo.project.name),
    "dynasty",
    "隋唐",
  );
  const navigation = surface.getByRole("navigation", { name: "主要内容" });
  await navigation.getByRole("button", { name: "讨论", exact: true }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
  await expect(shell.locator("[data-inscription-filter]")).toHaveCount(0);
  await expect(shell.locator("[data-filter-panel]")).toHaveCount(0);
  await navigation.getByRole("button", { name: "首页", exact: true }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );
  await openFilter(resetFilter);
  await expect(
    resetFilter.locator('[data-filter-category="dynasty"]'),
  ).toContainText("朝代⌄");
  await expect(resetFilter.locator("[data-filter-reset]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);
});

test("PC options use button semantics and commit immediately without changing records", async ({
  page,
}, testInfo) => {
  test.skip(expectedPlatform(testInfo.project.name) !== "pc");
  const { filter, shell } = await openQaInscriptions(page);
  const initialSnapshot = await visibleCatalogSnapshot(shell);
  await openFilter(filter);

  const dynasty = filter.locator('[data-filter-category="dynasty"]');
  await dynasty.click();
  const dynastyOptions = filter.locator('[data-filter-popover="dynasty"]');
  await expect(dynastyOptions).toBeVisible();
  await expect(dynastyOptions).toHaveAttribute("role", "group");
  await expect(dynastyOptions).toHaveAttribute("aria-label", "朝代选项");
  await expect(dynastyOptions.locator('[role="option"]')).toHaveCount(0);
  const suiTang = dynastyOptions.getByRole("button", {
    exact: true,
    name: "隋唐",
  });
  await expect(suiTang).toHaveAttribute("aria-pressed", "false");
  await suiTang.click();
  await expect(dynasty).toContainText("隋唐 ×");
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  await dynasty.click();
  await expect(dynasty).toContainText("朝代⌄");
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  const region = filter.locator('[data-filter-category="region"]');
  await region.click();
  const regionOptions = filter.locator('[data-filter-popover="region"]');
  const optionLabels = await regionOptions
    .getByRole("button")
    .allTextContents();
  expect(optionLabels).toEqual(
    expect.arrayContaining(["全部", "河南", "陕西", "山东", "四川"]),
  );
  expect(optionLabels).not.toContain("地区");
  await regionOptions
    .getByRole("button", { exact: true, name: "河南" })
    .click();
  await expect(region).toContainText("河南 ×");

  const inscriptionType = filter.locator(
    '[data-filter-category="inscriptionType"]',
  );
  await inscriptionType.click();
  const typeOptions = filter.locator('[data-filter-popover="inscriptionType"]');
  expect(await typeOptions.getByRole("button").allTextContents()).toEqual(
    expect.arrayContaining(["全部", "摩崖", "碑刻", "墓志", "造像记", "题记"]),
  );
  await page.keyboard.press("Escape");
  await expect(inscriptionType).toBeFocused();

  await filter.locator("[data-filter-reset]").click();
  for (const [key, label] of [
    ["dynasty", "朝代⌄"],
    ["script", "书体⌄"],
    ["inscriptionType", "类型⌄"],
    ["region", "地区⌄"],
  ] as const) {
    await expect(
      filter.locator(`[data-filter-category="${key}"]`),
    ).toContainText(label);
  }
  await expect(filter.locator("[data-filter-reset]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);
});

test("compact sheets keep draft state local, restore focus and reset committed state", async ({
  page,
}, testInfo) => {
  test.skip(expectedPlatform(testInfo.project.name) === "pc");
  const { filter, shell } = await openQaInscriptions(page);
  const initialSnapshot = await visibleCatalogSnapshot(shell);
  await openFilter(filter);

  const dynasty = filter.locator('[data-filter-category="dynasty"]');
  await dynasty.click();
  let sheet = filter.locator('[data-filter-sheet="dynasty"]');
  await expect(sheet).toHaveRole("dialog");
  await expect(sheet).toHaveAccessibleName("朝代");
  await sheet.getByLabel("隋唐", { exact: true }).check();
  await expect(dynasty).toContainText("朝代⌄");
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);
  await sheet.getByRole("button", { exact: true, name: "取消" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dynasty).toContainText("朝代⌄");
  await expect(dynasty).toBeFocused();

  await dynasty.click();
  sheet = filter.locator('[data-filter-sheet="dynasty"]');
  await sheet.getByLabel("魏晋南北朝", { exact: true }).check();
  await filter
    .locator("[data-filter-sheet-backdrop]")
    .click({ position: { x: 2, y: 2 } });
  await expect(sheet).toHaveCount(0);
  await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  await openFilter(filter);
  await dynasty.click();
  sheet = filter.locator('[data-filter-sheet="dynasty"]');
  await sheet.getByLabel("隋唐", { exact: true }).check();
  await sheet.getByRole("button", { exact: true, name: "确定" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dynasty).toContainText("隋唐 ×");
  await expect(dynasty).toBeFocused();
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);

  const script = filter.locator('[data-filter-category="script"]');
  await script.click();
  sheet = filter.locator('[data-filter-sheet="script"]');
  await sheet.getByLabel("行书", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(script).toContainText("书体⌄");
  await expect(script).toBeFocused();

  await script.click();
  sheet = filter.locator('[data-filter-sheet="script"]');
  await sheet.getByLabel("行书", { exact: true }).check();
  await sheet.getByRole("button", { exact: true, name: "重置" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dynasty).toContainText("朝代⌄");
  await expect(script).toContainText("书体⌄");
  await expect(filter.locator("[data-filter-reset]")).toBeFocused();
  await expect(filter.locator("[data-filter-reset]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await visibleCatalogSnapshot(shell)).toEqual(initialSnapshot);
});

test("all approved viewport matrices keep Filter in bounds and compact landscape sheets scrollable", async ({
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

  const { filter, shell } = await openQaInscriptions(page);
  const platform = expectedPlatform(testInfo.project.name);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(shell).toHaveAttribute("data-platform", platform);
    const userBox = await shell.locator("[data-user-trigger]").boundingBox();
    const filterBox = await filter
      .getByRole("button", { name: "打开筛选" })
      .boundingBox();
    if (userBox === null || filterBox === null) {
      throw new Error(
        `Missing utility geometry at ${viewport.width}x${viewport.height}`,
      );
    }
    expect(
      Math.abs(
        userBox.x + userBox.width / 2 - (filterBox.x + filterBox.width / 2),
      ),
    ).toBeLessThanOrEqual(1);
    expect(filterBox.y - (userBox.y + userBox.height)).toBe(8);
    expect(filterBox.x).toBeGreaterThanOrEqual(0);
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );

    await openFilter(filter);
    const panel = filter.locator("[data-filter-panel]");
    const panelBox = await panel.boundingBox();
    if (panelBox === null) throw new Error("Missing filter panel geometry");
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    const chipTops = await filter
      .locator("[data-filter-reset], [data-filter-category]")
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );
    expect(new Set(chipTops).size).toBe(1);

    const dynasty = filter.locator('[data-filter-category="dynasty"]');
    await dynasty.click();
    if (platform === "pc") {
      const popover = filter.locator('[data-filter-popover="dynasty"]');
      const popoverBox = await popover.boundingBox();
      if (popoverBox === null) throw new Error("Missing filter popover");
      expect(popoverBox.x).toBeGreaterThanOrEqual(0);
      expect(popoverBox.y).toBeGreaterThanOrEqual(0);
      expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
        viewport.width + 1,
      );
      expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
        viewport.height + 1,
      );
    } else {
      const sheet = filter.locator('[data-filter-sheet="dynasty"]');
      const sheetBox = await sheet.boundingBox();
      if (sheetBox === null) throw new Error("Missing filter sheet");
      expect(sheetBox.x).toBeGreaterThanOrEqual(0);
      expect(sheetBox.y).toBeGreaterThanOrEqual(0);
      expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(
        viewport.width + 1,
      );
      // The sheet enters with a bounded translate animation. Sample its settled
      // geometry so the assertion measures clipping rather than an in-flight
      // transform frame.
      await expect
        .poll(async () => {
          const settledBox = await sheet.boundingBox();
          return settledBox === null
            ? Number.POSITIVE_INFINITY
            : settledBox.y + settledBox.height;
        })
        .toBeLessThanOrEqual(viewport.height + 1);
      if (viewport.width > viewport.height) {
        const scrolling = await sheet.evaluate((node) => ({
          clientHeight: node.clientHeight,
          overflowY: getComputedStyle(node).overflowY,
          scrollHeight: node.scrollHeight,
        }));
        expect(["auto", "scroll"]).toContain(scrolling.overflowY);
        if (viewport.height <= 430) {
          expect(scrolling.scrollHeight).toBeGreaterThan(
            scrolling.clientHeight,
          );
        }
      }
    }

    await page.keyboard.press("Escape");
    await expect(dynasty).toBeFocused();
    await filter.getByRole("button", { name: "关闭筛选" }).click();
    await expect(filter.locator("[data-filter-panel]")).toHaveCount(0);
  }
});

test("Filter remains legible through themes and respects reduced motion", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { filter, shell, surface } = await openQaInscriptions(page);
  const userTrigger = shell.locator("[data-user-trigger]");

  for (const preference of ["light", "dark", "system"] as const) {
    await expect(shell).toHaveAttribute("data-theme-preference", preference);
    const trigger = await openFilter(filter);
    await expectOpaqueSurface(trigger);
    await expectOpaqueSurface(filter.locator("[data-filter-panel]"));
    await trigger.click();
    await expect(trigger).toBeFocused();

    if (preference === "system") break;
    await userTrigger.click();
    const userPage = shell.getByRole("dialog", { name: "用户页" });
    await expect(userPage).toBeVisible();
    await expect(
      userPage.getByRole("button", { name: "关闭用户页" }),
    ).toBeFocused();
    const userSettings = userPage.getByRole("button", {
      name: "打开设置",
    });
    await userSettings.click();
    const settings = shell.getByRole("dialog", { name: "设置" });
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: /切换主题/ }).click();
    await settings.getByRole("button", { name: "返回" }).click();
    await expect(settings).toHaveCount(0);
    await expect(userPage).toBeVisible();
    await expect(userSettings).toBeFocused();
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
    await expect(userPage).toHaveCount(0);
    await expect(userTrigger).toBeFocused();
  }

  await surface
    .getByRole("combobox", { name: "QA presentation platform" })
    .selectOption("phone");
  await expect(shell).toHaveAttribute("data-platform", "phone");
  await openFilter(filter);
  await filter.locator('[data-filter-category="dynasty"]').click();
  await expectOwnTextContrast(
    filter.locator('[data-filter-sheet="dynasty"] [data-filter-confirm]'),
  );
  await page.keyboard.press("Escape");
  await filter.getByRole("button", { name: "关闭筛选" }).click();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFilter(filter);
  await expect
    .poll(() =>
      filter
        .locator("[data-filter-panel]")
        .evaluate((node) => getComputedStyle(node).animationName),
    )
    .toBe("none");
});

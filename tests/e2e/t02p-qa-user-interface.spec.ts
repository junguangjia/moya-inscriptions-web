import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { devices, expect, test } from "@playwright/test";

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

const openQa = async (page: Page) => {
  const response = await page.goto("/dev/t02p/qa");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  const shell = surface.locator("[data-product-shell]");
  const trigger = shell.locator("[data-user-trigger]");
  await expect(trigger).toBeVisible();
  return { shell, surface, trigger };
};

const openUser = async (shell: Locator, trigger: Locator) => {
  await trigger.click();
  const userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await expect(
    userPage.getByRole("button", { name: "关闭用户页" }),
  ).toBeFocused();
  return userPage;
};

test("QA user UI is isolated from clean Development and formal routes", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");

  for (const path of ["/dev/t02p", "/"] as const) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("[data-qa-user-interface]")).toHaveCount(0);
    await expect(page.locator("[data-open-settings]")).toHaveCount(0);
    await expect(page.locator("[data-search-trigger]")).toHaveCount(
      path === "/" ? 3 : 0,
    );
    await expect(page.locator("[data-catalog-search]")).toHaveCount(
      path === "/" ? 1 : 0,
    );
  }

  const { shell } = await openQa(page);
  await expect(shell.locator("[data-qa-user-interface]")).toHaveCount(1);
  await expect(shell.locator("[data-open-settings]")).toHaveCount(0);
});

test("User opens on published content and reuses the ProductShell Settings owner", async ({
  page,
}, testInfo) => {
  const { shell, trigger } = await openQa(page);
  const userPage = await openUser(shell, trigger);

  await expect(userPage.getByRole("tab", { name: "发布" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    userPage.getByRole("heading", { name: "我发布过的内容" }),
  ).toBeVisible();
  await expect(
    userPage.locator('[data-user-panel="published"] [data-user-content-id]'),
  ).toHaveCount(8);
  await expect(
    userPage.getByRole("button", { name: "关闭用户页" }),
  ).toBeFocused();

  const settingsEntry = userPage.getByRole("button", { name: "打开设置" });
  await settingsEntry.click();
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await expect(shell.locator("[data-product-primary-layer]")).toHaveAttribute(
    "inert",
    "",
  );
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(userPage).toBeVisible();
  await expect(settingsEntry).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(userPage).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(shell).toHaveAttribute(
    "data-platform",
    expectedPlatform(testInfo.project.name),
  );
});

test("User traps focus and restores only its nearest QA harness exactly", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { shell, surface, trigger } = await openQa(page);
  const inscriptionsTab = surface
    .locator("[data-home-surface]")
    .getByRole("tab", { exact: true, name: "碑刻" });
  await inscriptionsTab.focus();
  await inscriptionsTab.press("Enter");
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  await expect(shell.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );

  const targets = surface.locator(
    "[data-qa-controls], [data-primary-navigation-pager], [data-primary-navigation-dock], [data-primary-navigation], [data-t02p-qa-search], [data-inscription-filter], [data-user-trigger]",
  );
  await expect(targets).toHaveCount(7);
  await surface.locator("[data-qa-controls]").evaluate((node) => {
    node.setAttribute("aria-hidden", "menu");
    (node as HTMLElement).inert = true;
  });
  await surface
    .locator("[data-t02p-qa-search]")
    .evaluate((node) => node.setAttribute("aria-hidden", "false"));
  await page.evaluate(() => {
    document.body.style.overflow = "clip";
    const outside = document.createElement("div");
    outside.dataset.t02pQaSearch = "";
    outside.id = "outside-qa-utility";
    outside.setAttribute("aria-hidden", "outside");
    document.body.append(outside);
  });
  const state = (nodes: Element[]) =>
    nodes.map((node) => ({
      ariaHidden: node.getAttribute("aria-hidden"),
      inert: (node as HTMLElement).inert,
      inertAttribute: node.getAttribute("inert"),
    }));
  const before = await targets.evaluateAll(state);

  const userPage = await openUser(shell, trigger);
  expect(
    await targets.evaluateAll((nodes) =>
      nodes.every(
        (node) =>
          node.getAttribute("aria-hidden") === "true" &&
          (node as HTMLElement).inert,
      ),
    ),
  ).toBe(true);
  await expect(page.locator("#outside-qa-utility")).toHaveAttribute(
    "aria-hidden",
    "outside",
  );
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    "hidden",
  );

  const focusable = userPage.locator(
    'button:not([disabled]):not([tabindex="-1"]):not([inert] *):visible',
  );
  const first = focusable.first();
  const last = focusable.last();
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();

  await first.click();
  await expect(userPage).toHaveCount(0);
  expect(await targets.evaluateAll(state)).toEqual(before);
  await expect(trigger).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("clip");
  await page.evaluate(() => {
    document.body.style.overflow = "";
    document.querySelector("#outside-qa-utility")?.remove();
  });
});

test("Published, saved, liked and history remain presentation-only", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { shell, trigger } = await openQa(page);
  const userPage = await openUser(shell, trigger);

  for (const [tab, heading] of [
    ["收藏", "我的收藏"],
    ["喜欢", "我喜欢的内容"],
    ["历史", "最近浏览"],
    ["发布", "我发布过的内容"],
  ] as const) {
    await userPage.getByRole("tab", { name: tab }).click();
    await expect(
      userPage.getByRole("heading", { name: heading }),
    ).toBeVisible();
  }

  const firstContent = userPage
    .locator('[data-user-panel="published"] [data-user-content-id]')
    .first();
  await expect(firstContent).toHaveAttribute(
    "data-user-content-id",
    "qa-visual-inscription-01",
  );
  await firstContent.click();
  await expect(userPage.locator("[data-user-intent-status]")).toContainText(
    "已记录内容打开意图",
  );
  await expect(page).toHaveURL(/\/dev\/t02p\/qa$/u);

  await userPage.locator("[data-user-avatar]").click();
  await expect(userPage.locator("[data-user-intent-status]")).toHaveText(
    "已记录更换头像意图",
  );
  await userPage.locator("[data-user-edit-profile]").click();
  await expect(userPage.locator("[data-user-intent-status]")).toHaveText(
    "已记录编辑资料意图",
  );
  await userPage.locator("[data-user-create]").click();
  await expect(userPage.locator("[data-user-intent-status]")).toHaveText(
    "已记录发布内容意图",
  );
  await expect(page).toHaveURL(/\/dev\/t02p\/qa$/u);
});

test("QA scenarios expose saved, liked, history, empty and avatar fallback", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { shell, surface } = await openQa(page);
  const selector = surface.getByRole("combobox", { name: "QA User scenario" });

  for (const [scenario, selectedTab] of [
    ["user-saved", "收藏"],
    ["user-liked", "喜欢"],
    ["user-history", "历史"],
  ] as const) {
    await selector.selectOption(scenario);
    const trigger = shell.locator("[data-user-trigger]");
    const userPage = await openUser(shell, trigger);
    await expect(
      userPage.getByRole("tab", { name: selectedTab }),
    ).toHaveAttribute("aria-selected", "true");
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
  }

  await selector.selectOption("user-empty-published");
  let userPage = await openUser(shell, shell.locator("[data-user-trigger]"));
  await expect(userPage.locator('[data-user-empty="published"]')).toHaveText(
    /暂无发布内容/u,
  );
  await userPage.getByRole("button", { name: "关闭用户页" }).click();

  await selector.selectOption("user-avatar-fallback");
  userPage = await openUser(shell, shell.locator("[data-user-trigger]"));
  await expect(userPage.locator("[data-user-avatar]")).toHaveText("访");
  await expect(userPage.locator("[data-user-avatar] img")).toHaveCount(0);
  await expect(shell.locator("[data-user-trigger] img")).toHaveCount(0);
});

test("User stays legible across themes and respects reduced motion", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const { shell, trigger } = await openQa(page);

  for (const preference of ["system", "light", "dark"] as const) {
    await expect(shell).toHaveAttribute("data-theme-preference", preference);
    const userPage = await openUser(shell, trigger);
    const [profileColors, cardColors] = await Promise.all([
      userPage.evaluate((node) => {
        const heading = node.querySelector("h1");
        if (heading === null) throw new Error("Missing User heading");
        return {
          background: getComputedStyle(node).backgroundColor,
          foreground: getComputedStyle(heading).color,
        };
      }),
      userPage
        .locator("article")
        .first()
        .evaluate((node) => {
          const heading = node.querySelector("h3");
          if (heading === null) throw new Error("Missing User card heading");
          return {
            background: getComputedStyle(node).backgroundColor,
            foreground: getComputedStyle(heading).color,
          };
        }),
    ]);
    expect(profileColors.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      contrastRatio(profileColors.foreground, profileColors.background),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(cardColors.foreground, cardColors.background),
    ).toBeGreaterThanOrEqual(4.5);

    if (preference !== "dark") {
      const userSettings = userPage.getByRole("button", {
        name: "打开设置",
      });
      await userSettings.click();
      const settings = shell.getByRole("dialog", { name: "设置" });
      await settings.getByRole("button", { name: /切换主题/ }).click();
      await settings.getByRole("button", { name: "返回" }).click();
      await expect(userPage).toBeVisible();
      await expect(userSettings).toBeFocused();
    }
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
    await expect(trigger).toBeFocused();
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const userPage = await openUser(shell, trigger);
  const motion = await userPage
    .locator("[data-user-avatar]")
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
      };
    });
  expect(motion.animationName).toBe("none");
  expect(["0s", "0.001s", "1ms"]).toContain(motion.transitionDuration);
});

test("approved viewport matrices keep the single-layer User UI in bounds", async ({
  page,
}, testInfo) => {
  const matrices = {
    "desktop-chromium": [
      { width: 1280, height: 720 },
      { width: 1512, height: 827 },
      { width: 1920, height: 1080 },
    ],
    "mobile-webkit": [
      { width: 375, height: 812 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 812, height: 375 },
      { width: 844, height: 390 },
      { width: 932, height: 430 },
    ],
    "tablet-webkit": [
      { width: 768, height: 1024 },
      { width: 820, height: 1180 },
      { width: 834, height: 1112 },
      { width: 1024, height: 768 },
      { width: 1180, height: 820 },
      { width: 1194, height: 834 },
    ],
  } as const;
  const viewports = matrices[testInfo.project.name as keyof typeof matrices];
  test.skip(viewports === undefined);
  if (viewports === undefined) return;

  const { shell } = await openQa(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const trigger = shell.locator("[data-user-trigger]");
    const userPage = await openUser(shell, trigger);
    const box = await userPage.boundingBox();
    if (box === null) throw new Error("Missing User page geometry");
    expect(Math.abs(box.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - viewport.height)).toBeLessThanOrEqual(1);
    const scroller = userPage.locator("[data-user-scroller]");
    const overflow = await scroller.evaluate((node) => ({
      clientHeight: node.clientHeight,
      clientWidth: node.clientWidth,
      overflowX: getComputedStyle(node).overflowX,
      overflowY: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      scrollWidth: node.scrollWidth,
    }));
    expect(overflow.overflowX).toBe("hidden");
    expect(["auto", "scroll"]).toContain(overflow.overflowY);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    if (
      testInfo.project.name === "mobile-webkit" &&
      viewport.width > viewport.height
    ) {
      expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
    }
    const documentOverflow = await page.evaluate(() => ({
      body: document.body.scrollWidth <= document.body.clientWidth,
      root:
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    }));
    expect(documentOverflow).toEqual({ body: true, root: true });
    await expect(
      userPage.getByRole("tablist", { name: "用户内容分类" }),
    ).toBeVisible();
    if (testInfo.project.name === "mobile-webkit") {
      for (const [key, label] of [
        ["published", "发布"],
        ["saved", "收藏"],
        ["liked", "喜欢"],
        ["history", "历史"],
      ] as const) {
        await userPage.getByRole("tab", { name: label }).click();
        await expect(userPage.locator("[data-user-pager]")).toHaveAttribute(
          "data-horizontal-pager-active-key",
          key,
        );
        const list = userPage.locator(
          `[data-user-panel="${key}"] [data-user-content-list]`,
        );
        await expect(list).toHaveAttribute("data-user-columns", "2");
        const columns = await list.evaluate((node) => {
          const lefts = Array.from(
            node.querySelectorAll<HTMLElement>("[data-user-content-id]"),
          ).map((card) => Math.round(card.getBoundingClientRect().left));
          return new Set(lefts).size;
        });
        expect(columns).toBe(2);
      }
    }
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
    await expect(userPage).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .not.toBe("hidden");
  }
});

test("User tabs preserve independent panel scroll and Settings returns to the same tab, scroll and opener", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const { shell, trigger } = await openQa(page);
  const userPage = await openUser(shell, trigger);
  const pager = userPage.locator("[data-user-pager]");
  const readScroll = (key: string) =>
    userPage
      .locator(`[data-user-panel="${key}"]`)
      .evaluate((node) => node.scrollTop);
  const positions: Record<string, number> = {};
  for (const [key, label, desired] of [
    ["published", "发布", 220],
    ["saved", "收藏", 150],
    ["liked", "喜欢", 80],
    ["history", "历史", 110],
  ] as const) {
    await userPage.getByRole("tab", { name: label }).click();
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-active-key",
      key,
    );
    positions[key] = await userPage
      .locator(`[data-user-panel="${key}"]`)
      .evaluate((node, top) => {
        node.scrollTop = top;
        node.dispatchEvent(new Event("scroll"));
        return node.scrollTop;
      }, desired);
    expect(positions[key]).toBeGreaterThan(0);
  }
  for (const [key, label] of [
    ["published", "发布"],
    ["saved", "收藏"],
    ["liked", "喜欢"],
    ["history", "历史"],
  ] as const) {
    await userPage.getByRole("tab", { name: label }).click();
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-active-key",
      key,
    );
    await expect.poll(() => readScroll(key)).toBe(positions[key]);
  }
  const sourceScroll = await page.evaluate(() => window.scrollY);
  const settingsEntry = userPage.locator("[data-user-settings]");
  await settingsEntry.click();
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(settingsEntry).toBeFocused();
  await expect(pager).toHaveAttribute(
    "data-horizontal-pager-active-key",
    "history",
  );
  await expect.poll(() => readScroll("history")).toBe(positions.history);
  expect(await page.evaluate(() => window.scrollY)).toBe(sourceScroll);

  await userPage.getByRole("tab", { name: "历史" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(pager).toHaveAttribute(
    "data-horizontal-pager-active-key",
    "liked",
  );
  await expect(userPage.getByRole("tab", { name: "喜欢" })).toBeFocused();
  await expect(userPage.locator('[data-user-panel="history"]')).toHaveAttribute(
    "inert",
    "",
  );
  await expect(userPage.locator('[data-user-panel="liked"]')).toHaveAttribute(
    "aria-hidden",
    "false",
  );
});

test("User content follows trusted horizontal input and vertical reading never changes category", async ({
  page: projectPage,
  context: projectContext,
  browser,
  browserName,
}, testInfo) => {
  // Mobile WebKit does not expose wheel or touch-drag injection in Playwright.
  // Chromium covers native Phone touch. WebKit covers the distinct PC wheel
  // path; separate mobile matrices retain their mobile context and tap paths.
  // A context created here inherits the project's device options, so the
  // mobile and tablet WebKit projects must spread the desktop descriptor:
  // otherwise the iPhone or iPad user agent keeps the shell on phone or
  // tablet in auto mode, and the PC presentation would rest solely on the QA
  // harness select having taken effect before the shell is asserted.
  const inputPlatform = browserName === "chromium" ? "phone" : "pc";
  const viewport = {
    width: inputPlatform === "phone" ? 390 : 1512,
    height: 600,
  };
  const inputContext =
    browserName === "chromium"
      ? await browser.newContext({
          ...devices["iPhone 15"],
          baseURL: testInfo.project.use.baseURL as string,
          viewport,
        })
      : testInfo.project.use.isMobile === true
        ? await browser.newContext({
            ...devices["Desktop Safari"],
            baseURL: testInfo.project.use.baseURL as string,
            isMobile: false,
            hasTouch: false,
            viewport,
          })
        : null;
  const context = inputContext ?? projectContext;
  const page = inputContext === null ? projectPage : await context.newPage();
  testInfo.annotations.push({
    type: "input-evidence",
    description:
      browserName === "chromium"
        ? "Chromium trusted CDP touch injection; no physical iPhone evidence"
        : "Desktop WebKit trusted wheel input on PC presentation; mobile WebKit touch and physical iPhone touch NOT RUN",
  });
  try {
    await page.setViewportSize(viewport);
    const { shell, surface, trigger } = await openQa(page);
    await surface
      .getByRole("combobox", { name: "QA presentation platform" })
      .selectOption(inputPlatform);
    await expect(shell).toHaveAttribute("data-platform", inputPlatform);
    const userPage = await openUser(shell, trigger);
    const pager = userPage.locator("[data-user-pager]");
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-platform",
      inputPlatform,
    );
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-scroll-owner",
      "panel",
    );
    await pager.evaluate((node) => {
      const frame = node as HTMLElement;
      frame.dataset.testProgressSamples = "[]";
      frame.dataset.testCommitSamples = "[]";
      frame.dataset.testTrustedInputs = "0";
      for (const type of ["wheel", "touchmove"]) {
        frame.addEventListener(
          type,
          (event) => {
            if (event.isTrusted)
              frame.dataset.testTrustedInputs = String(
                Number(frame.dataset.testTrustedInputs ?? "0") + 1,
              );
          },
          { capture: true },
        );
      }
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "data-horizontal-pager-progress") {
            const samples = JSON.parse(
              frame.dataset.testProgressSamples ?? "[]",
            ) as number[];
            samples.push(Number(frame.dataset.horizontalPagerProgress));
            frame.dataset.testProgressSamples = JSON.stringify(samples);
          }
          if (record.attributeName === "data-horizontal-pager-active-key") {
            const samples = JSON.parse(
              frame.dataset.testCommitSamples ?? "[]",
            ) as string[];
            samples.push(frame.dataset.horizontalPagerActiveKey ?? "");
            frame.dataset.testCommitSamples = JSON.stringify(samples);
          }
        }
      }).observe(frame, {
        attributes: true,
        attributeFilter: [
          "data-horizontal-pager-progress",
          "data-horizontal-pager-active-key",
        ],
      });
    });
    const box = await pager.boundingBox();
    if (box === null) throw new Error("Missing User pager geometry");
    const { x, y } = await pager.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const x = box.x + box.width * 0.8;
      // QA chrome stays visible. Deliver native input to exposed product content
      // rather than to an overlay or a point below the viewport.
      for (
        let y = Math.min(innerHeight - 40, box.bottom - 24);
        y > box.top + 20;
        y -= 16
      ) {
        if (node.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      throw new Error("No exposed User pager point for native input");
    });
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    const published = userPage.locator('[data-user-panel="published"]');
    await expect
      .poll(() => published.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-active-key",
      "published",
    );
    expect(
      await pager.evaluate((node) =>
        JSON.parse((node as HTMLElement).dataset.testCommitSamples ?? "[]"),
      ),
    ).toEqual([]);

    if (browserName === "chromium") {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 12; step += 1) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x - (box.width * 0.66 * step) / 12, y }],
        });
        // Frame-by-frame input samples preserve the continuous browser gesture path.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
      const dragging = await pager.evaluate((node) => {
        const frame = node as HTMLElement;
        return {
          activeKey: frame.dataset.horizontalPagerActiveKey,
          commits: JSON.parse(frame.dataset.testCommitSamples ?? "[]"),
          progress: JSON.parse(
            frame.dataset.testProgressSamples ?? "[]",
          ) as number[],
        };
      });
      expect(dragging.activeKey).toBe("published");
      expect(dragging.commits).toEqual([]);
      expect(dragging.progress.some((value) => value > 0 && value < 1)).toBe(
        true,
      );
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await session.detach();
    } else {
      // The PC handler must consume a large explicit horizontal wheel as one
      // adjacent-category request, not let native overflow cross several panels.
      await page.mouse.wheel(box.width * 0.8, 0);
    }
    await expect(pager).toHaveAttribute(
      "data-horizontal-pager-active-key",
      "saved",
    );
    await expect(pager).toHaveAttribute("data-user-pager-scrolling", "false");
    await expect(userPage.getByRole("tab", { name: "收藏" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Complete another genuine vertical-reading input after the horizontal
    // settle, then sample key, selected tab, geometry and commit history together.
    // A transient saved state followed by a second commit must not pass.
    const saved = userPage.locator('[data-user-panel="saved"]');
    await expect(saved).toHaveAttribute("aria-hidden", "false");
    await expect(saved.locator("[data-user-content-list]")).toHaveAttribute(
      "data-user-layout-ready",
      "true",
    );
    await expect
      .poll(() =>
        saved.evaluate((node) => node.scrollHeight - node.clientHeight),
      )
      .toBeGreaterThan(0);
    const readingPoint = await saved.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const x = box.x + box.width * 0.8;
      for (
        let y = Math.min(innerHeight - 40, box.bottom - 24);
        y > box.top + 20;
        y -= 16
      ) {
        if (node.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      throw new Error("No exposed saved panel point for native reading input");
    });
    await page.mouse.move(readingPoint.x, readingPoint.y);
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest<HTMLElement>("[data-user-panel]")?.dataset.userPanel,
          readingPoint,
        ),
      )
      .toBe("saved");
    const savedScrollBefore = await saved.evaluate((node) => node.scrollTop);
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => saved.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(savedScrollBefore);
    const evidence = await userPage.evaluate((node) => {
      const frame = node.querySelector<HTMLElement>("[data-user-pager]");
      const savedPanel = node.querySelector<HTMLElement>(
        '[data-user-panel="saved"]',
      );
      if (frame === null || savedPanel === null)
        throw new Error("Missing User pager or saved panel");
      return {
        activeKey: frame.dataset.horizontalPagerActiveKey,
        commits: JSON.parse(
          frame.dataset.testCommitSamples ?? "[]",
        ) as string[],
        progress: JSON.parse(
          frame.dataset.testProgressSamples ?? "[]",
        ) as number[],
        currentProgress: Number(frame.dataset.horizontalPagerProgress),
        panelAlignment:
          savedPanel.getBoundingClientRect().left -
          frame.getBoundingClientRect().left,
        scrolling: frame.dataset.userPagerScrolling,
        selectedTabs: Array.from(
          node.querySelectorAll<HTMLElement>(
            '[data-user-tab][aria-selected="true"]',
          ),
          (tab) => tab.dataset.userTab,
        ),
        trustedInputs: Number(frame.dataset.testTrustedInputs ?? "0"),
      };
    });
    expect(evidence.activeKey).toBe("saved");
    expect(evidence.selectedTabs).toEqual(["saved"]);
    expect(evidence.scrolling).toBe("false");
    expect(evidence.currentProgress).toBeCloseTo(1, 2);
    expect(Math.abs(evidence.panelAlignment)).toBeLessThanOrEqual(2);
    expect(evidence.commits).toEqual(["saved"]);
    expect(evidence.trustedInputs).toBeGreaterThan(0);
    if (browserName === "chromium") {
      expect(evidence.progress.some((value) => value > 0 && value < 1)).toBe(
        true,
      );
    }
    await expect(
      userPage.locator("[data-user-intent-status]"),
    ).not.toContainText("内容打开");
    await expect(page).toHaveURL(/\/dev\/t02p\/qa$/u);
    await expect(shell).toHaveAttribute("data-active-destination", "home");
  } finally {
    await inputContext?.close();
  }
});

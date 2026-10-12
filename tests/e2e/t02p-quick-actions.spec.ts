import { setTimeout as pause } from "node:timers/promises";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { writeFile } from "node:fs/promises";
import { devices, expect, test } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

const ready = async (page: Page, path = "/dev/t02p/qa?qaChrome=hidden") => {
  // These journeys exercise the two-column long-press layer; phone opens the
  // single-column post feed unless the reader chose Double.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("yoyi.home-feed-layout", "double");
    } catch {
      // Storage may be unavailable; the layout then follows the platform.
    }
  });
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
};
const homeFeed = (page: Page, surface: "home" | "calligraphy") =>
  page.locator(
    `[data-home-feed-panel="${surface === "home" ? "discover" : "calligraphy"}"]`,
  );
const feedCards = (page: Page, surface: "home" | "calligraphy") =>
  homeFeed(page, surface).locator('[data-quick-actions="enabled"]');
const homeCard = (page: Page) => feedCards(page, "home").first();
const settlePanel = async (panel: Locator) => {
  await expect
    .poll(
      () =>
        panel.evaluate(async (node) => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const frame = node.closest<HTMLElement>("[data-horizontal-pager]");
          if (frame === null) throw new Error("Missing QA action pager");
          const layouts = node.querySelectorAll<HTMLElement>(
            "[data-home-masonry]",
          );
          return (
            frame.dataset.horizontalPagerScrolling === "false" &&
            Math.abs(
              node.getBoundingClientRect().left -
                frame.getBoundingClientRect().left,
            ) <= 2 &&
            Array.from(layouts).every(
              (layout) => layout.dataset.layoutReady === "true",
            )
          );
        }),
      { intervals: [0] },
    )
    .toBe(true);
};
const selectCalligraphy = async (page: Page) => {
  const home = page.locator("[data-home-surface]");
  const tab = home.getByRole("tab", { exact: true, name: "书帖" });
  if (await page.locator("[data-qa-controls]").count()) {
    // QA chrome intentionally covers the top tabs; preserve it and activate
    // through the existing keyboard path before injecting native gestures.
    await tab.focus();
    await tab.press("Enter");
  } else await tab.click();
  await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
  await expect(homeFeed(page, "calligraphy")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await settlePanel(homeFeed(page, "calligraphy"));
};
const selectDiscussionTopics = async (page: Page) => {
  const shell = page.locator("[data-product-shell]");
  const navigation = shell.locator("[data-primary-navigation]");
  if ((await navigation.getAttribute("data-minimized")) === "true") {
    await navigation.locator('[data-selected="true"]').click();
    await expect(navigation).toHaveAttribute("data-minimized", "false");
  }
  await navigation.getByRole("button", { exact: true, name: "讨论" }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
  const discussion = shell.locator("[data-discussion-surface]");
  const tab = discussion.getByRole("tab", { exact: true, name: "专题" });
  if (await page.locator("[data-qa-controls]").count()) {
    await tab.focus();
    await tab.press("Enter");
  } else await tab.click();
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(
    discussion.getByRole("tabpanel", { name: "专题" }),
  ).toHaveAttribute("aria-hidden", "false");
  await settlePanel(discussion.getByRole("tabpanel", { name: "专题" }));
};
const anchorFor = async (button: Locator) => {
  const box = await button.boundingBox();
  if (!box) throw new Error("Missing card geometry");
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + Math.min(80, box.height / 2)),
  };
};
/**
 * An unobscured card point. A paging drag starts on the side away from its
 * direction ("right" for a leftward swipe, "left" for a rightward one) so it
 * can travel more than half the pager in single- and two-column feeds alike.
 */
const nativeCard = async (
  page: Page,
  surface: "home" | "calligraphy",
  side: "center" | "left" | "right" = "center",
) => {
  const cards = feedCards(page, surface);
  await settlePanel(homeFeed(page, surface));
  const findHit = () =>
    cards.evaluateAll((buttons, side) => {
      for (const [index, button] of buttons.entries()) {
        const box = button.getBoundingClientRect();
        const x = Math.round(
          box.x +
            box.width *
              (side === "right" ? 0.85 : side === "left" ? 0.15 : 0.5),
        );
        if (
          x <= (side === "right" ? innerWidth / 2 : 24) ||
          x >=
            (side === "left"
              ? innerWidth / 2
              : innerWidth - (side === "right" ? 24 : 100))
        )
          continue;
        const top = Math.max(24, box.top + 12);
        const bottom = Math.min(innerHeight - 100, box.bottom - 12);
        for (let y = top; y <= bottom; y += 24) {
          if (document.elementFromPoint(x, y) === button)
            return { index, point: { x, y } };
        }
      }
      return null;
    }, side);
  await expect.poll(findHit).not.toBeNull();
  const hit = await findHit();
  if (hit === null)
    throw new Error(`No unobscured ${surface} card for native input`);
  return { button: cards.nth(hit.index), point: hit.point };
};
const targetFor = async (page: Page, action: string) => {
  const box = await page
    .locator(`[data-quick-action="${action}"]`)
    .boundingBox();
  if (!box) throw new Error("Missing action geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const touch = (
  session: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: { x: number; y: number; id: number }[],
) => session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
const drag = async (
  session: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  for (let step = 1; step <= 10; step += 1) {
    await touch(session, "touchMove", [
      {
        id: 1,
        x: from.x + ((to.x - from.x) * step) / 10,
        y: from.y + ((to.y - from.y) * step) / 10,
      },
    ]);
    await pause(16);
  }
};

test("browser mouse holds toggle QA states without moving cards, and keyboard still opens Detail", async ({
  page,
}) => {
  await ready(page);
  const button = homeCard(page);
  const card = button.locator("..");
  const before = await card.boundingBox();
  for (const action of ["like", "favorite", "share"] as const) {
    const start = await anchorFor(button);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
    const position = await targetFor(page, action);
    await page.mouse.move(position.x, position.y, { steps: 6 });
    await expect(
      page.locator(`[data-quick-action="${action}"]`),
    ).toHaveAttribute("data-candidate", "true");
    await page.mouse.up();
    await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
    await expect(page.locator("[data-product-shell]")).toHaveAttribute(
      "data-detail-open",
      "false",
    );
    await page.mouse.move(0, 0);
    await expect.poll(() => card.boundingBox()).toEqual(before);
    if (action === "share")
      await expect(card.getByRole("status")).toHaveText(
        "QA：分享动作已触发（未分享）",
      );
    else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await expect(
        page.locator(`[data-quick-action="${action}"]`),
      ).toHaveAttribute("data-state-active", "true");
      const target = await targetFor(page, action);
      await page.mouse.move(target.x, target.y, { steps: 6 });
      await page.mouse.up();
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await expect(
        page.locator(`[data-quick-action="${action}"]`),
      ).toHaveAttribute("data-state-active", "false");
      await page.mouse.up();
    }
  }
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-product-shell]")).toHaveAttribute(
    "data-detail-open",
    "true",
  );
});

for (const path of [
  "/",
  "/dev/t02p",
  "/dev/t02p/qa",
  "/dev/t02p/qa?qaChrome=hidden",
]) {
  test(`QA scope and pager permission on ${path}`, async ({ page }) => {
    await ready(page, path);
    const enabled = path.startsWith("/dev/t02p/qa");
    const pager = page.locator("[data-home-surface] [data-home-feed-pager]");
    const shell = page.locator("[data-product-shell]");
    // The phone single-column feed lets a post's image stage pan locally.
    const phoneSingle =
      (await shell.getAttribute("data-platform")) === "phone" &&
      (await shell.getAttribute("data-feed-layout")) === "single";
    await expect(pager).toHaveCSS(
      "touch-action",
      (await pager.getAttribute("data-home-pager-platform")) === "pc" ||
        phoneSingle
        ? /^(?:manipulation|pan-x pan-y pinch-zoom)$/u
        : "pan-y pinch-zoom",
    );
    if (path === "/") {
      // Formal content cards use real community actions, not the QA harness.
      await expect(
        page.locator("[data-t02p-qa-harness], [data-qa-controls]"),
      ).toHaveCount(0);
      await expect(page.locator("[data-quick-action-qa-log]")).toHaveCount(0);
      expect(
        await page
          .locator(
            '[data-content-type="catalog"] [data-quick-actions="enabled"]',
          )
          .count(),
      ).toBeGreaterThan(0);
      await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
      return;
    }
    if (!enabled) {
      await expect(page.locator("[data-quick-actions]")).toHaveCount(0);
      await expect(page.locator("[data-quick-action-feedback]")).toHaveCount(0);
      return;
    }
    for (const surface of ["home", "calligraphy"] as const) {
      expect(await feedCards(page, surface).count()).toBeGreaterThan(0);
    }
    await expect(page.locator("[data-calligraphy-all]")).toHaveCount(1);
    await expect(
      homeFeed(page, "calligraphy").getByRole("tablist", {
        includeHidden: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.locator(
        '[data-home-feed-panel="inscriptions"] [data-quick-actions]',
      ),
    ).toHaveCount(0);
    await expect(page.locator("[data-quick-action-qa-log]")).toHaveCount(0);
  });
}

for (const chrome of ["default", "hidden"] as const) {
  for (const surface of ["home", "calligraphy"] as const) {
    for (const phase of ["pending", "open", "sliding"] as const) {
      test(`Chromium native touch ${surface}: second finger during ${phase}, chrome ${chrome}, cancels without action and pinches in the same sequence`, async ({
        browser,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop-chromium",
          "Continuous multi-touch injection requires Chromium CDP; WebKit physical touch remains an Owner gate.",
        );
        const baseURL = testInfo.project.use.baseURL;
        if (typeof baseURL !== "string") throw new Error("Missing base URL");
        const context = await browser.newContext({
          ...devices["iPhone 15"],
          baseURL,
        });
        try {
          const page = await context.newPage();
          const session = await context.newCDPSession(page);
          await ready(
            page,
            chrome === "hidden"
              ? "/dev/t02p/qa?qaChrome=hidden"
              : "/dev/t02p/qa",
          );
          if (surface === "calligraphy") await selectCalligraphy(page);
          const { button, point: initialPoint } = await nativeCard(
            page,
            surface,
          );
          const ancestors = await button.evaluate((node) => {
            const chain = [];
            for (
              let element: Element | null = node;
              element;
              element = element.parentElement
            ) {
              chain.push({
                tag: element.tagName,
                className: element.className,
                touchAction: getComputedStyle(element).touchAction,
              });
            }
            return chain;
          });
          for (const ancestor of ancestors)
            expect(
              ancestor.touchAction === "auto" ||
                ancestor.touchAction === "manipulation" ||
                ancestor.touchAction.includes("pinch-zoom"),
            ).toBe(true);
          await page.evaluate(() => {
            document.documentElement.dataset.quickActionTrustedMoves = "0";
            window.addEventListener(
              "touchmove",
              (event) => {
                if (event.isTrusted)
                  document.documentElement.dataset.quickActionTrustedMoves =
                    String(
                      Number(
                        document.documentElement.dataset
                          .quickActionTrustedMoves,
                      ) + 1,
                    );
              },
              { capture: true },
            );
          });
          let first = { ...initialPoint, id: 1 };
          await touch(session, "touchStart", [first]);
          if (phase !== "pending")
            await expect(
              page.locator("[data-quick-action-menu]"),
            ).toBeVisible();
          if (phase === "sliding") {
            const target = await targetFor(page, "favorite");
            await drag(session, first, target);
            first = { ...target, id: 1 };
            await expect(
              page.locator('[data-quick-action="favorite"]'),
            ).toHaveAttribute("data-candidate", "true");
          }
          const currentActions = await button.evaluate((node) => {
            const actions = [];
            for (
              let element: Element | null = node;
              element;
              element = element.parentElement
            )
              actions.push(getComputedStyle(element).touchAction);
            return actions;
          });
          expect(currentActions).toEqual(
            ancestors.map((ancestor) => ancestor.touchAction),
          );
          const initialScale = await page.evaluate(
            () => window.visualViewport!.scale,
          );
          await touch(session, "touchStart", [
            first,
            { id: 2, x: first.x + 80, y: first.y },
          ]);
          await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
          for (let step = 1; step <= 12; step += 1) {
            await touch(session, "touchMove", [
              { id: 1, x: first.x - (40 * step) / 12, y: first.y },
              { id: 2, x: first.x + 80 + (120 * step) / 12, y: first.y },
            ]);
            await pause(30);
          }
          // A cancelled menu is insufficient: assert actual compositor zoom before lifting either finger.
          await expect
            .poll(() => page.evaluate(() => window.visualViewport!.scale))
            .toBeGreaterThan(initialScale + 0.2);
          const afterScale = await page.evaluate(
            () => window.visualViewport!.scale,
          );
          const trustedMoves = await page.evaluate(() =>
            Number(document.documentElement.dataset.quickActionTrustedMoves),
          );
          expect(trustedMoves).toBeGreaterThan(0);
          const evidencePath = testInfo.outputPath(
            "native-pinch-evidence.json",
          );
          await writeFile(
            evidencePath,
            JSON.stringify(
              {
                chrome,
                surface,
                phase,
                ancestors,
                initialScale,
                afterScale,
                trustedMoves,
              },
              null,
              2,
            ),
          );
          await testInfo.attach("native-pinch-evidence", {
            path: evidencePath,
            contentType: "application/json",
          });
          await touch(session, "touchEnd", []);
          await expect(page.locator("[data-product-shell]")).toHaveAttribute(
            "data-detail-open",
            "false",
          );
          // Return to the initial scale with an actual inward pinch, never an emulation scale command.
          await touch(session, "touchStart", [
            { id: 1, x: 60, y: 300 },
            { id: 2, x: 330, y: 300 },
          ]);
          for (let step = 1; step <= 12; step += 1) {
            await touch(session, "touchMove", [
              { id: 1, x: 60 + (125 * step) / 12, y: 300 },
              { id: 2, x: 330 - (125 * step) / 12, y: 300 },
            ]);
            await pause(30);
          }
          await touch(session, "touchEnd", []);
          await expect
            .poll(() => page.evaluate(() => window.visualViewport!.scale))
            .toBeCloseTo(initialScale, 1);
          const next = initialPoint;
          await touch(session, "touchStart", [{ ...next, id: 1 }]);
          for (const action of ["like", "favorite"])
            await expect(
              page.locator(`[data-quick-action="${action}"]`),
            ).toHaveAttribute("data-state-active", "false");
          await expect(
            page.locator("[data-quick-action-feedback]"),
          ).toHaveCount(0);
          await touch(session, "touchEnd", []);
          await page.touchscreen.tap(next.x, next.y);
          await expect(page.locator("[data-product-shell]")).toHaveAttribute(
            "data-detail-open",
            "true",
          );
          const detail = page.getByRole("dialog", { name: "资料详情" });
          await detail
            .getByRole("button", { exact: true, name: "返回" })
            .click();
          await expect(detail).toHaveCount(0);
          await expect(button).toBeFocused();
          const scrollOwner = homeFeed(page, surface);
          const beforeTop = await scrollOwner.evaluate(
            (node) => node.scrollTop,
          );
          const { point: scrollStart } = await nativeCard(page, surface);
          await touch(session, "touchStart", [{ ...scrollStart, id: 1 }]);
          await drag(session, scrollStart, {
            x: scrollStart.x,
            y: scrollStart.y - 110,
          });
          await touch(session, "touchEnd", []);
          await expect
            .poll(() => scrollOwner.evaluate((node) => node.scrollTop))
            .toBeGreaterThan(beforeTop + 20);
          const { point: pageStart } = await nativeCard(
            page,
            surface,
            surface === "home" ? "right" : "left",
          );
          await touch(session, "touchStart", [{ ...pageStart, id: 1 }]);
          // Discover advances to Nearby; the last Home tab, Calligraphy, returns
          // to Inscriptions with a rightward swipe instead of a removed category.
          await drag(session, pageStart, {
            x: surface === "home" ? 5 : page.viewportSize()!.width - 5,
            y: pageStart.y,
          });
          const held = await scrollOwner.evaluate((panel) => {
            const frame = panel.closest<HTMLElement>(
              "[data-horizontal-pager]",
            )!;
            return {
              displacement: Math.abs(
                panel.getBoundingClientRect().left -
                  frame.getBoundingClientRect().left,
              ),
              width: frame.clientWidth,
            };
          });
          expect(held.displacement).toBeGreaterThan(held.width / 2);
          await touch(session, "touchEnd", []);
          await expect(page.locator("[data-home-feed-pager]")).toHaveAttribute(
            "data-horizontal-pager-active-key",
            surface === "home" ? "nearby" : "inscriptions",
          );
          await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
        } finally {
          await context.close();
        }
      });
    }
  }
}

for (const surface of ["home", "calligraphy"] as const) {
  test(`Chromium native touch ${surface} preserves pre-hold vertical scroll, horizontal paging, and single-finger action`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Continuous compositor touch injection requires Chromium CDP.",
    );
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") throw new Error("Missing base URL");
    const context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
    });
    try {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await ready(page);
      const activate = async () => {
        if (surface === "calligraphy") await selectCalligraphy(page);
      };
      const activeCards = () => feedCards(page, surface);
      const scrollOwner = homeFeed(page, surface);
      await activate();
      const { point: start } = await nativeCard(page, surface);
      await touch(session, "touchStart", [{ ...start, id: 1 }]);
      await drag(session, start, { x: start.x, y: start.y - 110 });
      await touch(session, "touchEnd", []);
      await expect
        .poll(() => scrollOwner.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(20);
      await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
      await ready(page);
      await activate();
      const pager = page.locator("[data-home-feed-pager]");
      const { point: origin } = await nativeCard(
        page,
        surface,
        surface === "home" ? "right" : "left",
      );
      await touch(session, "touchStart", [{ ...origin, id: 1 }]);
      await drag(session, origin, {
        x: surface === "home" ? 5 : page.viewportSize()!.width - 5,
        y: origin.y,
      });
      await touch(session, "touchEnd", []);
      await expect(pager).toHaveAttribute(
        "data-horizontal-pager-active-key",
        surface === "home" ? "nearby" : "inscriptions",
      );
      await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
      await ready(page);
      await activate();
      const active = activeCards().first();
      const hold = await anchorFor(active);
      const top = await scrollOwner.evaluate((node) => node.scrollTop);
      await touch(session, "touchStart", [{ ...hold, id: 1 }]);
      await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
      const destination = await targetFor(page, "favorite");
      await drag(session, hold, destination);
      await expect(
        page.locator('[data-quick-action="favorite"]'),
      ).toHaveAttribute("data-candidate", "true");
      await touch(session, "touchEnd", []);
      expect(await scrollOwner.evaluate((node) => node.scrollTop)).toBe(top);
      await touch(session, "touchStart", [{ ...hold, id: 1 }]);
      await expect(
        page.locator('[data-quick-action="favorite"]'),
      ).toHaveAttribute("data-state-active", "true");
      await drag(session, hold, await targetFor(page, "favorite"));
      await touch(session, "touchEnd", []);
      await touch(session, "touchStart", [{ ...hold, id: 1 }]);
      await expect(
        page.locator('[data-quick-action="favorite"]'),
      ).toHaveAttribute("data-state-active", "false");
      await touch(session, "touchEnd", []);
    } finally {
      await context.close();
    }
  });
}

test("synthetic-pointer layout stays within rendered viewport edges and cancels on resize", async ({
  page,
}) => {
  await ready(page);
  const button = homeCard(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Missing viewport");
  for (const point of [
    { x: 16, y: 16 },
    { x: viewport.width - 16, y: 16 },
    { x: 16, y: viewport.height - 16 },
    { x: viewport.width - 16, y: viewport.height - 16 },
  ]) {
    const properties = {
      bubbles: true,
      button: 0,
      isPrimary: true,
      pointerId: 73,
      pointerType: "touch",
      clientX: point.x,
      clientY: point.y,
    };
    await button.dispatchEvent("pointerdown", properties);
    await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
    for (const target of await page.locator("[data-quick-action]").all()) {
      const box = await target.boundingBox();
      if (!box) throw new Error("Missing target");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await button.dispatchEvent("pointermove", {
        ...properties,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
      await expect(target).toHaveAttribute("data-candidate", "true");
    }
    await button.dispatchEvent("pointercancel", properties);
    await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
  }
  const point = await anchorFor(button);
  await button.dispatchEvent("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 74,
    pointerType: "touch",
    clientX: point.x,
    clientY: point.y,
  });
  await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
  await page.setViewportSize({
    width: viewport.height,
    height: viewport.width,
  });
  await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
});

test("Topic Detail feed cards remain ordinary cards and Detail return preserves opener", async ({
  page,
}) => {
  await ready(
    page,
    "/dev/t02p/qa?qaChrome=hidden&scenario=topics-catalog-collection",
  );
  await selectDiscussionTopics(page);
  await page
    .locator(
      '[data-discussion-surface] [aria-hidden="false"] [data-topic-card]',
    )
    .click();
  const topic = page.locator("[data-topic-detail]");
  await expect(topic).toBeVisible();
  await expect(topic.locator("[data-catalog-card]")).toHaveCount(6);
  await expect(topic.locator("[data-open-catalog]")).toHaveCount(0);
  await expect(topic.locator("[data-quick-actions]")).toHaveCount(0);
  await ready(page);
  const button = homeCard(page);
  await button.click();
  const detail = page.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { exact: true, name: "返回" }).click();
  await expect(detail).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press("Space");
  await expect(detail).toBeVisible();
});

for (const surface of ["home", "calligraphy"] as const) {
  test(`Chromium native zoomed ${surface} menu keeps rendered targets and hit testing inside the visual viewport`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Continuous native pinch input requires Chromium CDP; physical Safari remains an Owner gate.",
    );
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") throw new Error("Missing base URL");
    const context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
    });
    try {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await ready(page);
      if (surface === "calligraphy") await selectCalligraphy(page);
      const { point } = await nativeCard(page, surface);
      await touch(session, "touchStart", [
        { ...point, id: 1 },
        { x: point.x + 80, y: point.y, id: 2 },
      ]);
      for (let step = 1; step <= 12; step += 1) {
        await touch(session, "touchMove", [
          { x: point.x - (40 * step) / 12, y: point.y, id: 1 },
          { x: point.x + 80 + (120 * step) / 12, y: point.y, id: 2 },
        ]);
        await pause(30);
      }
      await touch(session, "touchEnd", []);
      await expect
        .poll(() => page.evaluate(() => window.visualViewport!.scale))
        .toBeGreaterThan(2);
      // CDP input uses CSS coordinates relative to the visual viewport.
      const pan = await page.evaluate(() => ({
        x: window.visualViewport!.width / 2,
        y: window.visualViewport!.height * 0.8,
      }));
      await touch(session, "touchStart", [{ ...pan, id: 1 }]);
      await drag(session, pan, { x: pan.x, y: pan.y / 4 });
      await touch(session, "touchEnd", []);
      // Let native fling finish before starting a fresh press. Input used to
      // stop an active fling is noncancelable in Chromium.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const viewport = window.visualViewport!;
            let last = "";
            let stable = 0;
            const frame = () => {
              const current = `${viewport.offsetLeft}:${viewport.offsetTop}:${viewport.scale}`;
              stable = current === last ? stable + 1 : 0;
              last = current;
              if (stable === 30) resolve();
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          }),
      );
      const viewport = await page.evaluate(() => {
        const v = window.visualViewport!;
        return {
          scale: v.scale,
          left: v.offsetLeft,
          top: v.offsetTop,
          width: v.width,
          height: v.height,
        };
      });
      const exposed = await page.evaluate((v) => {
        for (let y = 80; y < v.height * v.scale - 80; y += 30) {
          for (let x = 80; x < v.width * v.scale - 80; x += 30) {
            const target = document.elementFromPoint(
              v.left + x / v.scale,
              v.top + y / v.scale,
            );
            if (target?.matches('[data-quick-actions="enabled"]'))
              return { x, y };
          }
        }
        return null;
      }, viewport);
      if (!exposed) throw new Error("No exposed card after native pinch");
      await page.evaluate(() => {
        window.addEventListener(
          "pointerdown",
          (event) => {
            const target = event.target as HTMLElement;
            document.body.dataset.zoomedDown = JSON.stringify({
              x: event.clientX,
              y: event.clientY,
              enabled: target.getAttribute("data-quick-actions"),
              target: target.tagName,
              trusted: event.isTrusted,
            });
          },
          { once: true },
        );
      });
      const input = {
        x: exposed.x / viewport.scale,
        y: exposed.y / viewport.scale,
      };
      await touch(session, "touchStart", [{ ...input, id: 1 }]);
      const actualDown = await page.evaluate(() =>
        JSON.parse(document.body.dataset.zoomedDown!),
      );
      expect(actualDown).toMatchObject({ enabled: "enabled", trusted: true });
      await writeFile(
        testInfo.outputPath("zoom-input-start.json"),
        JSON.stringify({
          viewport,
          exposed,
          actual: await page.evaluate(() => document.body.dataset.zoomedDown),
        }),
      );
      await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
      const bounds = await page
        .locator("[data-quick-action]")
        .evaluateAll((targets) =>
          targets.map((node) => {
            const b = node.getBoundingClientRect();
            return {
              action: node.getAttribute("data-quick-action"),
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
            };
          }),
        );
      for (const box of bounds) {
        expect(box.x).toBeGreaterThanOrEqual(viewport.left);
        expect(box.y).toBeGreaterThanOrEqual(viewport.top);
        expect(box.x + box.width).toBeLessThanOrEqual(
          viewport.left + viewport.width,
        );
        expect(box.y + box.height).toBeLessThanOrEqual(
          viewport.top + viewport.height,
        );
        expect(box.width * viewport.scale).toBeCloseTo(64, 1);
      }
      const target = bounds.find((box) => box.action === "share")!;
      await drag(session, input, {
        x: target.x + target.width / 2 - viewport.left,
        y: target.y + target.height / 2 - viewport.top,
      });
      await expect(page.locator('[data-quick-action="share"]')).toHaveAttribute(
        "data-candidate",
        "true",
      );
      await page.screenshot({
        path: testInfo.outputPath("native-zoomed-menu.png"),
      });
      await touch(session, "touchEnd", []);
      await expect(page.locator("[data-quick-action-feedback]")).toHaveText(
        "QA：分享动作已触发（未分享）",
      );
      await expect(page.locator("[data-product-shell]")).toHaveAttribute(
        "data-detail-open",
        "false",
      );
      expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(
        viewport.scale,
      );
      const evidencePath = testInfo.outputPath(
        "native-zoomed-menu-evidence.json",
      );
      await writeFile(
        evidencePath,
        JSON.stringify({ surface, viewport, exposed, bounds }, null, 2),
      );
      await testInfo.attach("native-zoomed-menu-evidence", {
        path: evidencePath,
        contentType: "application/json",
      });
    } finally {
      await context.close();
    }
  });
}

for (const chrome of ["default", "hidden"] as const) {
  test(`Nearby and Topic QA actions retain layout and activation, chrome ${chrome}`, async ({
    page,
  }) => {
    // Nearby retains its Home deep link; topics use their Discussion tab in both QA chrome modes.
    for (const [feed, kind] of [
      ["附近", "nearby"],
      ["专题", "topic"],
    ] as const) {
      await ready(
        page,
        `/dev/t02p/qa?feed=${kind === "nearby" ? "nearby" : "discover"}${chrome === "hidden" ? "&qaChrome=hidden" : ""}`,
      );
      if (kind === "topic") await selectDiscussionTopics(page);
      await expect(
        page.getByRole("tab", { name: feed, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      const activePanel = page.locator(
        kind === "nearby"
          ? '[data-home-feed-panel="nearby"]'
          : '[data-discussion-surface] [data-horizontal-panel-key="topics"]',
      );
      await expect
        .poll(() =>
          activePanel.evaluate((panel) => {
            const frame = panel.closest<HTMLElement>("[data-horizontal-pager]");
            if (frame === null) throw new Error("Missing QA action pager");
            return (
              frame.dataset.horizontalPagerScrolling === "false" &&
              Math.abs(
                panel.getBoundingClientRect().left -
                  frame.getBoundingClientRect().left,
              ) <= 2
            );
          }),
        )
        .toBe(true);
      const buttons = page.locator(
        `[data-quick-action-content-kind="${kind}"]`,
      );
      const exposedPoint = () =>
        buttons.evaluateAll((nodes) => {
          for (const [index, node] of nodes.entries()) {
            const box = node.getBoundingClientRect();
            // The visible QA controls may cover a card's centre while its
            // side remains exposed. Hit-test actual points inside that card.
            for (const x of [
              box.x + box.width / 2,
              box.right - 12,
              box.left + 12,
            ]) {
              for (
                let y = Math.max(box.top + 12, 24);
                y < Math.min(box.bottom - 12, innerHeight - 110);
                y += 20
              ) {
                const hit = document.elementFromPoint(x, y);
                if (hit && node.contains(hit))
                  return { index, point: { x, y } };
              }
            }
          }
          return null;
        });
      await expect.poll(exposedPoint).not.toBeNull();
      const exposed = await exposedPoint();
      if (exposed === null) throw new Error("No exposed settled QA card");
      const button = buttons.nth(exposed.index);
      const card = button.locator("..");
      // Compare the same settled hover state; existing desktop cards translate -2px on hover.
      await page.mouse.move(exposed.point.x, exposed.point.y);
      await card.evaluate(async (node) => {
        await Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        );
      });
      const before = await card.boundingBox();
      const nodes = await card.locator("button button").count();
      expect(nodes).toBe(0);
      for (const action of ["like", "favorite", "share"] as const) {
        const point = exposed.point;
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await expect(page.locator("[data-quick-action-menu]")).toBeVisible();
        const target = await targetFor(page, action);
        await page.mouse.move(target.x, target.y, { steps: 6 });
        await expect(
          page.locator(`[data-quick-action="${action}"]`),
        ).toHaveAttribute("data-candidate", "true");
        await page.mouse.up();
        await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
        await expect(page.locator("[data-topic-detail]")).toHaveCount(0);
        await expect(page.locator("[data-product-shell]")).toHaveAttribute(
          "data-detail-open",
          "false",
        );
        await page.mouse.move(exposed.point.x, exposed.point.y);
        await card.evaluate(async (node) => {
          await Promise.all(
            node.getAnimations().map((animation) => animation.finished),
          );
        });
        expect(await card.boundingBox()).toEqual(before);
        if (action === "share")
          await expect(card.getByRole("status")).toHaveText(
            "QA：分享动作已触发（未分享）",
          );
        else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await expect(
            page.locator(`[data-quick-action="${action}"]`),
          ).toHaveAttribute("data-state-active", "true");
          const again = await targetFor(page, action);
          await page.mouse.move(again.x, again.y);
          await page.mouse.up();
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await expect(
            page.locator(`[data-quick-action="${action}"]`),
          ).toHaveAttribute("data-state-active", "false");
          await page.mouse.up();
        }
      }
      await page.mouse.click(exposed.point.x, exposed.point.y);
      if (kind === "topic") {
        const detail = page.locator("[data-topic-detail]");
        await expect(detail).toBeVisible();
        await detail
          .getByRole("button", { name: "返回专题", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(detail).toHaveCount(0);
      } else {
        await expect(page.locator("[data-topic-detail]")).toHaveCount(0);
        await expect(page.locator("[data-product-shell]")).toHaveAttribute(
          "data-detail-open",
          "false",
        );
      }
      await button.focus();
      await page.keyboard.press("Enter");
      if (kind === "nearby") {
        await expect(page.locator("[data-topic-detail]")).toHaveCount(0);
        await expect(page.locator("[data-product-shell]")).toHaveAttribute(
          "data-detail-open",
          "false",
        );
      } else {
        const topic = page.locator("[data-topic-detail]");
        await expect(topic).toBeVisible();
        await topic
          .getByRole("button", { name: "返回专题", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(topic).toHaveCount(0);
        await expect(button).toBeFocused();
      }
    }
  });
}

for (const chrome of ["default", "hidden"] as const) {
  test(`Chromium nearby and topic continuous touch cancels for native pinch, ${chrome}`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Continuous compositor input requires Chromium CDP; physical Safari is a separate Owner gate.",
    );
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") throw new Error("Missing base URL");
    const context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL,
    });
    const evidence: unknown[] = [];
    try {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      for (const kind of ["nearby", "topic"] as const) {
        for (const phase of ["pending", "open"] as const) {
          await ready(
            page,
            `/dev/t02p/qa?feed=${kind === "nearby" ? "nearby" : "discover"}${chrome === "hidden" ? "&qaChrome=hidden" : ""}`,
          );
          if (kind === "topic") await selectDiscussionTopics(page);
          const buttons = page.locator(
            `[data-quick-action-content-kind="${kind}"]`,
          );
          // The visible QA aside covers the first Topic cards. Reveal later
          // real content through its existing scroll owner before hit testing.
          if (chrome === "default" && kind === "topic")
            await buttons.last().scrollIntoViewIfNeeded();
          const findHit = () =>
            buttons.evaluateAll((nodes) => {
              for (const [index, node] of nodes.entries()) {
                const box = node.getBoundingClientRect();
                const left = Math.max(box.left + 12, 36);
                const right = Math.min(box.right - 12, innerWidth - 201);
                if (left > right) continue;
                for (const x of [
                  Math.max(left, Math.min(right, box.x + box.width / 2)),
                  right,
                  left,
                ]) {
                  // Keep the existing reserve and the full twelve-step span:
                  // the first finger moves -36px and the second reaches +200px.
                  if (x > innerWidth - 130 || x < 36 || x + 200 >= innerWidth)
                    continue;
                  for (
                    let y = Math.max(30, box.top + 12);
                    y < Math.min(innerHeight - 110, box.bottom - 12);
                    y += 20
                  ) {
                    const target = document.elementFromPoint(x, y);
                    if (target && node.contains(target)) return { index, x, y };
                  }
                }
              }
              return null;
            });
          await expect
            .poll(async () => {
              const hit = await findHit();
              if (hit === null && chrome === "default" && kind === "topic") {
                // The last visible card can leave the panel at its scroll end.
                // Shift the real card sampling grid into the narrow exposed
                // band while retaining the full native pinch span and hit test.
                await page
                  .locator(
                    '[data-discussion-surface] [data-horizontal-pager-scroll-owner="panel"] [data-horizontal-panel-key="topics"]',
                  )
                  .evaluate((panel) => {
                    panel.scrollTop = Math.max(0, panel.scrollTop - 4);
                  });
              }
              return hit;
            })
            .not.toBeNull();
          const hit = await findHit();
          if (hit === null)
            throw new Error(
              `Missing exposed native ${kind} card (${phase}, ${chrome})`,
            );
          const button = buttons.nth(hit.index);
          const ancestors = await button.evaluate((node) => {
            const result: { tag: string; touchAction: string }[] = [];
            for (let e: Element | null = node; e; e = e.parentElement)
              result.push({
                tag: e.tagName,
                touchAction: getComputedStyle(e).touchAction,
              });
            return result;
          });
          for (const ancestor of ancestors)
            expect(ancestor.touchAction).toMatch(
              /^(?:auto|manipulation|.*pinch-zoom.*)$/,
            );
          const first = { id: 1, x: hit.x, y: hit.y };
          await touch(session, "touchStart", [first]);
          if (phase === "open")
            await expect(
              page.locator("[data-quick-action-menu]"),
            ).toBeVisible();
          const beforeScale = await page.evaluate(() => visualViewport!.scale);
          await touch(session, "touchStart", [
            first,
            { id: 2, x: first.x + 80, y: first.y },
          ]);
          await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
          const pager = page.locator(
            kind === "nearby"
              ? "[data-home-feed-pager]"
              : "[data-discussion-surface] [data-horizontal-pager]",
          );
          await expect(pager).toHaveAttribute(
            "data-horizontal-pager-scrolling",
            "false",
          );
          await expect(pager).toHaveAttribute(
            "data-horizontal-pager-active-key",
            kind === "nearby" ? "nearby" : "topics",
          );
          for (let step = 1; step <= 12; step++) {
            await touch(session, "touchMove", [
              { id: 1, x: first.x - step * 3, y: first.y },
              { id: 2, x: first.x + 80 + step * 10, y: first.y },
            ]);
            await pause(30);
          }
          await expect
            .poll(() => page.evaluate(() => visualViewport!.scale))
            .toBeGreaterThan(beforeScale + 0.2);
          const afterScale = await page.evaluate(() => visualViewport!.scale);
          await touch(session, "touchEnd", []);
          await touch(session, "touchStart", [
            { id: 1, x: 60, y: 300 },
            { id: 2, x: 330, y: 300 },
          ]);
          for (let step = 1; step <= 12; step++) {
            await touch(session, "touchMove", [
              { id: 1, x: 60 + (125 * step) / 12, y: 300 },
              { id: 2, x: 330 - (125 * step) / 12, y: 300 },
            ]);
            await pause(30);
          }
          await touch(session, "touchEnd", []);
          await expect
            .poll(() => page.evaluate(() => visualViewport!.scale))
            .toBeCloseTo(beforeScale, 1);
          await touch(session, "touchStart", [first]);
          for (const action of ["like", "favorite"])
            await expect(
              page.locator(`[data-quick-action="${action}"]`),
            ).toHaveAttribute("data-state-active", "false");
          await touch(session, "touchEnd", []);
          await expect(
            page.locator("[data-quick-action-feedback]"),
          ).toHaveCount(0);
          await page.touchscreen.tap(first.x, first.y);
          await expect(page.locator("[data-product-shell]")).toHaveAttribute(
            "data-detail-open",
            "false",
          );
          if (kind === "topic")
            await expect(page.locator("[data-topic-detail]")).toBeVisible();
          else await expect(page.locator("[data-topic-detail]")).toHaveCount(0);
          evidence.push({
            chrome,
            kind,
            phase,
            ancestors,
            beforeScale,
            afterScale,
          });
        }
      }
    } finally {
      await testInfo.attach("nearby-topic-native-pinch", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      await context.close();
    }
  });
}

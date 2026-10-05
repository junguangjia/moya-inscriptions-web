import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { devices, expect, test } from "@playwright/test";

import type { CDPSession, Locator, Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

type HomeFeed = "discover" | "nearby" | "inscriptions" | "calligraphy";

const productShell = (surface: Locator) =>
  surface.locator("[data-product-shell]");

const homeSurface = (surface: Locator) =>
  surface.locator('[data-primary-destination="home"] [data-home-surface]');

const calligraphySurface = (surface: Locator) =>
  homeSurface(surface).locator('[data-home-feed-panel="calligraphy"]');

const activateCalligraphy = async (surface: Locator) => {
  await expect(productShell(surface)).toHaveAttribute(
    "data-active-destination",
    "home",
  );
  await settleFeed(homeSurface(surface), "calligraphy");
  await expect(calligraphySurface(surface)).toBeVisible();
};

const gotoWithRetry = async (page: Page, target: string) => {
  let response: Awaited<ReturnType<Page["goto"]>> | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await page.goto(target);
      break;
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof Error) ||
        !error.message.includes("is interrupted by another navigation")
      ) {
        throw error;
      }
      await page.waitForTimeout(100);
    }
  }
  return response;
};

const openSurface = async (page: Page, qa = true) => {
  const target = qa ? "/dev/t02p/qa" : "/dev/t02p";
  const response = await gotoWithRetry(page, target);
  expect(response?.status()).toBe(200);
  const surface = page.locator(
    qa ? "[data-t02p-qa-harness]" : "[data-clean-product-preview]",
  );
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await activateCalligraphy(surface);
  return { calligraphy: calligraphySurface(surface), surface };
};

const settleFeed = async (home: Locator, feed: HomeFeed) => {
  const pager = home.locator("[data-home-feed-pager]");
  // This setup selection must also work beneath visible QA overlay controls;
  // the gesture tests below deliver trusted input to exposed product content.
  await home
    .locator(`[data-tab-key="${feed}"]`)
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
  await expect(pager).toHaveAttribute("data-home-pager-scrolling", "false");
  await expect
    .poll(() =>
      pager.evaluate((node, target) => {
        const panel = node.querySelector<HTMLElement>(
          `[data-home-feed-panel="${target}"]`,
        )!;
        return Math.abs(
          panel.getBoundingClientRect().left -
            node.getBoundingClientRect().left,
        );
      }, feed),
    )
    .toBeLessThanOrEqual(2);
};

const primaryScrollEvidence = async (surface: Locator) =>
  productShell(surface).evaluate((node) => {
    const shell = node as HTMLElement;
    const section = shell.querySelector<HTMLElement>(
      '[data-home-feed-panel="calligraphy"]',
    );
    if (section === null) throw new Error("Missing Home Calligraphy panel");
    const element =
      shell.dataset.platform === "pc"
        ? (document.scrollingElement as HTMLElement)
        : section;
    return {
      maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      top: element.scrollTop,
    };
  });

const writePrimaryScroll = async (surface: Locator, desired: number) =>
  productShell(surface).evaluate((node, top) => {
    const shell = node as HTMLElement;
    const section = shell.querySelector<HTMLElement>(
      '[data-home-feed-panel="calligraphy"]',
    );
    if (section === null) throw new Error("Missing Home Calligraphy panel");
    const element =
      shell.dataset.platform === "pc"
        ? (document.scrollingElement as HTMLElement)
        : section;
    element.scrollTop = Math.min(
      top,
      Math.max(0, element.scrollHeight - element.clientHeight),
    );
    if (shell.dataset.platform === "pc") {
      window.dispatchEvent(new Event("scroll"));
    } else {
      element.dispatchEvent(new Event("scroll"));
    }
    return element.scrollTop;
  }, desired);

const waitForInitialFeedScroll = async (
  home: Locator,
  feed: HomeFeed = "calligraphy",
) => {
  // Wait for layout and restoration on the real reading owner.
  await home.evaluate(
    (node, target) =>
      new Promise<void>((resolve) => {
        const shell = node.closest<HTMLElement>("[data-product-shell]")!;
        const pager = node.querySelector<HTMLElement>(
          "[data-home-feed-pager]",
        )!;
        const panel = node.querySelector<HTMLElement>(
          `[data-home-feed-panel="${target}"]`,
        )!;
        const scroller =
          shell.dataset.platform === "pc" ? document.scrollingElement! : panel;
        const content = panel.querySelector<HTMLElement>(
          "[data-home-masonry], [data-catalog-presentation]",
        )!;
        let previous = "";
        let stableFrames = 0;
        const sample = () => {
          const ready =
            (content.hasAttribute("data-home-masonry")
              ? content.dataset.layoutReady === "true"
              : content.dataset.catalogPresentationState === "populated") &&
            [...panel.querySelectorAll("img")].every((image) => {
              // Offscreen lazy images need not load before reading can start.
              const bounds = image.getBoundingClientRect();
              const viewport = panel.getBoundingClientRect();
              return (
                image.complete ||
                bounds.bottom < Math.max(0, viewport.top) ||
                bounds.top > Math.min(innerHeight, viewport.bottom)
              );
            }) &&
            pager.dataset.homePagerScrolling === "false" &&
            Math.abs(
              panel.getBoundingClientRect().left -
                pager.getBoundingClientRect().left,
            ) <= 2 &&
            scroller.scrollTop === 0;
          const geometry = JSON.stringify([
            scroller.scrollHeight,
            scroller.clientHeight,
            pager.getBoundingClientRect().height,
            content.getBoundingClientRect().height,
          ]);
          stableFrames = ready && geometry === previous ? stableFrames + 1 : 0;
          previous = geometry;
          if (stableFrames >= 3) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    feed,
  );
};

const trustedHorizontalPointDrag = async (
  page: Page,
  session: CDPSession,
  pager: Locator,
  point: { readonly x: number; readonly y: number },
  direction: 1 | -1 = 1,
) => {
  const pagerWidth = await pager.evaluate((node) => node.clientWidth);
  const { x, y } = point;
  const available =
    direction === 1 ? x - 8 : (await page.evaluate(() => innerWidth)) - x - 8;
  const distance = Math.min(Math.max(64, pagerWidth * 0.58), available);

  const initialPanelLeft = await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    frame.dataset.testMaximumHorizontalDisplacement = "0";
    frame.dataset.testTrustedTouchEvents = "0";
    frame.addEventListener(
      "touchmove",
      (event) => {
        if (event.isTrusted) {
          frame.dataset.testTrustedTouchEvents = String(
            Number(frame.dataset.testTrustedTouchEvents ?? "0") + 1,
          );
        }
      },
      { capture: true },
    );
    return frame.firstElementChild!.firstElementChild!.getBoundingClientRect()
      .left;
  });

  await session.send("Input.dispatchTouchEvent", {
    touchPoints: [{ x, y }],
    type: "touchStart",
  });
  for (let step = 1; step <= 12; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [{ x: x - (direction * distance * step) / 12, y }],
      type: "touchMove",
    });
    await page.waitForTimeout(12);
    await pager.evaluate((node, initialLeft) => {
      const frame = node as HTMLElement;
      const currentLeft =
        frame.firstElementChild!.firstElementChild!.getBoundingClientRect()
          .left;
      frame.dataset.testMaximumHorizontalDisplacement = String(
        Math.max(
          Number(frame.dataset.testMaximumHorizontalDisplacement ?? "0"),
          Math.abs(currentLeft - initialLeft),
        ),
      );
    }, initialPanelLeft);
  }
  await session.send("Input.dispatchTouchEvent", {
    touchPoints: [],
    type: "touchEnd",
  });
  await page.waitForTimeout(50);
};

const trustedHorizontalCardDrag = async (
  page: Page,
  session: CDPSession,
  pager: Locator,
  card: Locator,
  direction: 1 | -1 = 1,
) => {
  const startEvidence = await card.evaluate((node, dragDirection) => {
    const rect = node.getBoundingClientRect();
    const hits: string[] = [];
    for (const xFactor of dragDirection === 1
      ? [0.9, 0.8, 0.7, 0.6]
      : [0.1, 0.2, 0.3, 0.4]) {
      for (const yFactor of [0.4, 0.25, 0.6]) {
        const x = rect.left + rect.width * xFactor;
        const y = rect.top + Math.min(rect.height * yFactor, 120);
        const hit = document.elementFromPoint(x, y);
        if (node.contains(hit)) return { hits, point: { x, y } };
        hits.push(
          `${hit?.tagName ?? "none"}.${hit?.className ?? ""}@${x},${y}`,
        );
      }
    }
    return { hits, point: null };
  }, direction);
  if (startEvidence.point === null) {
    throw new Error(
      `No hit-testable point inside swipe card: ${startEvidence.hits.join(" | ")}`,
    );
  }
  const { x, y } = startEvidence.point;
  await trustedHorizontalPointDrag(page, session, pager, { x, y }, direction);
};

const trustedDragEvidence = (pager: Locator) =>
  pager.evaluate((node) => {
    const frame = node as HTMLElement;
    return {
      maximumHorizontalDisplacement: Number(
        frame.dataset.testMaximumHorizontalDisplacement ?? "0",
      ),
      trustedTouchEvents: Number(frame.dataset.testTrustedTouchEvents ?? "0"),
    };
  });

const shortFeedBlankEvidence = (pager: Locator) =>
  pager.evaluate((node) => {
    const frame = node as HTMLElement;
    const card = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="calligraphy"] [data-catalog-card]',
    );
    if (card === null) throw new Error("Missing short Calligraphy feed card");
    const x = window.innerWidth / 2;
    const y = window.innerHeight - 180;
    const hit = document.elementFromPoint(x, y);
    return {
      belowCard: y > card.getBoundingClientRect().bottom + 24,
      inPager: hit !== null && frame.contains(hit),
      point: { x, y },
    };
  });

test("MIG-C1 keeps runtime all-Calligraphy truthful and QA metadata isolated", async ({
  page,
}) => {
  const runtime = await openSurface(page, false);
  await expect(runtime.calligraphy.locator("[data-catalog-card]")).toHaveCount(
    1,
  );
  await expect(runtime.calligraphy).toContainText("运行时书帖");
  await expect(runtime.calligraphy).not.toContainText("视觉 QA 合成");
  await expect(
    runtime.calligraphy.locator(
      'input[type="search"], [data-calligraphy-filter]',
    ),
  ).toHaveCount(0);
  await expect(homeSurface(runtime.surface).getByRole("tab")).toHaveText([
    "发现",
    "附近",
    "碑刻",
    "书帖",
  ]);
  await expect(
    runtime.surface.locator(
      "[data-calligraphy-category-pager], [data-calligraphy-category-tab]",
    ),
  ).toHaveCount(0);

  const qa = await openSurface(page);
  const cards = qa.calligraphy.locator("[data-catalog-card]");
  await expect(cards).toHaveCount(12);
  expect(
    await cards.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-catalog-id"),
        kind: node.getAttribute("data-catalog-kind"),
      })),
    ),
  ).toEqual(
    Array.from({ length: 12 }, (_, index) => ({
      id: `qa-visual-calligraphy-${String(index + 1).padStart(2, "0")}`,
      kind: "calligraphy",
    })),
  );
  await settleFeed(homeSurface(qa.surface), "inscriptions");
  await settleFeed(homeSurface(qa.surface), "calligraphy");
  await expect(cards).toHaveCount(12);

  const formalResponse = await gotoWithRetry(page, "/");
  expect(formalResponse?.status()).toBe(200);
  await expect(
    page.locator('[data-catalog-id^="qa-visual-calligraphy-"]'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      "[data-calligraphy-category-pager], [data-calligraphy-category-tab]",
    ),
  ).toHaveCount(0);
});

test("MIG-C1 card actions preserve trusted touch paging with local horizontal control", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Trusted compositor touch injection uses the Chromium protocol.",
  );
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    baseURL,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const response = await gotoWithRetry(page, "/dev/t02p/qa");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await expect(productShell(surface)).toHaveAttribute("data-platform", "phone");
  await surface
    .locator("[data-qa-controls]")
    .evaluate((node) => ((node as HTMLElement).style.display = "none"));

  const homePager = surface.locator(
    '[data-primary-destination="home"] [data-home-feed-pager]',
  );
  const homeCard = homePager
    .locator('[data-home-feed-panel="discover"] [data-open-catalog]')
    .nth(1);
  await expect(homeCard).toBeVisible();
  await expect(homeCard).toHaveCSS(
    "touch-action",
    /^(?:pan-x pan-y pinch-zoom|manipulation)$/u,
  );
  await trustedHorizontalCardDrag(page, session, homePager, homeCard);
  await expect(surface.locator("[data-home-surface]")).toHaveAttribute(
    "data-active-home-feed",
    "nearby",
  );
  const homeEvidence = await trustedDragEvidence(homePager);
  expect(homeEvidence.trustedTouchEvents).toBeGreaterThan(0);
  expect(homeEvidence.maximumHorizontalDisplacement).toBeGreaterThan(40);

  await activateCalligraphy(surface);
  const calligraphyPager = homeSurface(surface).locator(
    "[data-home-feed-pager]",
  );
  const calligraphyCard = calligraphyPager
    .locator('[data-home-feed-panel="calligraphy"] [data-open-catalog]')
    .nth(1);
  await expect(calligraphyCard).toBeVisible();
  await expect(calligraphyCard).toHaveCSS(
    "touch-action",
    /^(?:pan-x pan-y pinch-zoom|manipulation)$/u,
  );
  await trustedHorizontalCardDrag(
    page,
    session,
    calligraphyPager,
    calligraphyCard,
    -1,
  );
  await expect(homeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );
  const calligraphyEvidence = await trustedDragEvidence(calligraphyPager);
  expect(calligraphyEvidence.trustedTouchEvents).toBeGreaterThan(0);
  expect(calligraphyEvidence.maximumHorizontalDisplacement).toBeGreaterThan(40);
  await session.detach();
  await context.close();
});

test("MIG-C1 keeps blank space below a short Calligraphy feed inside the phone and tablet pager", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("desktop"),
    "PC keeps content-sized Calligraphy paging.",
  );
  const response = await gotoWithRetry(page, "/");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-clean-product-preview]");
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await activateCalligraphy(surface);
  const pager = homeSurface(surface).locator("[data-home-feed-pager]");
  await expect(
    pager.locator('[data-home-feed-panel="calligraphy"] [data-catalog-card]'),
  ).toHaveCount(1);
  await page.waitForTimeout(250);

  const blank = await shortFeedBlankEvidence(pager);
  expect(blank.belowCard).toBe(true);
  expect(blank.inPager).toBe(true);
});

test("MIG-C1 accepts a trusted horizontal drag from blank space below a short Calligraphy feed", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Trusted compositor touch injection uses the Chromium protocol.",
  );
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    baseURL,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const response = await gotoWithRetry(page, "/");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-clean-product-preview]");
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await activateCalligraphy(surface);
  const pager = homeSurface(surface).locator("[data-home-feed-pager]");
  await expect(
    pager.locator('[data-home-feed-panel="calligraphy"] [data-catalog-card]'),
  ).toHaveCount(1);
  await page.waitForTimeout(250);

  const blank = await shortFeedBlankEvidence(pager);
  expect(blank.belowCard).toBe(true);
  expect(blank.inPager).toBe(true);

  await trustedHorizontalPointDrag(page, session, pager, blank.point, -1);
  await expect(homeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    "inscriptions",
  );
  const evidence = await trustedDragEvidence(pager);
  expect(evidence.trustedTouchEvents).toBeGreaterThan(0);
  expect(evidence.maximumHorizontalDisplacement).toBeGreaterThan(40);
  await session.detach();
  await context.close();
});

test("MIG-C1 pager follows progress and commits only on release", async ({
  page,
}, testInfo) => {
  const { surface } = await openSurface(page);
  const home = homeSurface(surface);
  await settleFeed(home, "discover");
  const pager = home.locator("[data-home-feed-pager]");
  const indicator = home.locator("[data-top-tab-indicator]");
  await expect(home.getByRole("tab")).toHaveText([
    "发现",
    "附近",
    "碑刻",
    "书帖",
  ]);
  const pc = (await pager.getAttribute("data-home-pager-platform")) === "pc";
  await expect(pager).toHaveCSS(
    "scroll-snap-type",
    pc ? "x mandatory" : "none",
  );
  await expect(pager).toHaveCSS(
    "touch-action",
    pc ? /^(?:pan-x pan-y pinch-zoom|manipulation)$/u : "pan-y pinch-zoom",
  );

  if (testInfo.project.name.startsWith("desktop")) {
    await pager.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 3,
      deltaY: 70,
    });
    await page.waitForTimeout(180);
    await expect(home).toHaveAttribute("data-active-home-feed", "discover");
    await pager.dispatchEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 70,
      deltaY: 3,
    });
    await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
    return;
  }

  await expect(pager).toHaveAttribute("data-category-pager-engine", "embla");
  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    // Controlled touch delivery exercises the actual core. Trusted browser
    // input, vertical scrolling and native pinch are covered separately below.
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.5],
    ] as const) {
      const point = {
        identifier: 1,
        target: frame,
        clientX:
          frame.getBoundingClientRect().left +
          frame.clientWidth * (0.75 - progress),
        clientY: 300,
      };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: [point] },
        changedTouches: { value: [point] },
      });
      frame.dispatchEvent(event);
    }
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "discover");
  await expect(pager).toHaveAttribute(
    "data-horizontal-pager-scrolling",
    "true",
  );
  await expect(
    home.getByRole("tablist", { name: "首页内容范围" }),
  ).toHaveAttribute("data-progress-driven", "true");
  await expect
    .poll(() =>
      indicator.evaluate((node) => {
        const track = node.parentElement!;
        const first = track
          .querySelector<HTMLElement>('[data-tab-key="discover"]')!
          .getBoundingClientRect();
        const second = track
          .querySelector<HTMLElement>('[data-tab-key="nearby"]')!
          .getBoundingClientRect();
        return (
          (node.getBoundingClientRect().left - first.left) /
          (second.left - first.left)
        );
      }),
    )
    .toBeCloseTo(0.5, 1);

  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    const point = {
      identifier: 1,
      target: frame,
      clientX: frame.getBoundingClientRect().left - frame.clientWidth * 0.25,
      clientY: 300,
    };
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: [point] },
      changedTouches: { value: [point] },
    });
    frame.dispatchEvent(event);
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "discover");
  const release = await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    const point = {
      identifier: 1,
      target: frame,
      clientX: frame.getBoundingClientRect().left - frame.clientWidth * 0.25,
      clientY: 300,
    };
    const event = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: [] },
      changedTouches: { value: [point] },
    });
    frame.dispatchEvent(event);
    const discover = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="discover"]',
    )!;
    const nearby = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="nearby"]',
    )!;
    return {
      active: frame.closest<HTMLElement>("[data-home-surface]")!.dataset
        .activeHomeFeed,
      discoverInert: discover.inert,
      discoverHidden: discover.getAttribute("aria-hidden"),
      nearbyInert: nearby.inert,
      nearbyHidden: nearby.getAttribute("aria-hidden"),
    };
  });
  expect(release).toEqual({
    active: "nearby",
    discoverInert: true,
    discoverHidden: "true",
    nearbyInert: false,
    nearbyHidden: "false",
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");

  const beforeCancelledDrag = await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    const panel = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="nearby"]',
    )!;
    const before =
      panel.getBoundingClientRect().left - frame.getBoundingClientRect().left;
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.6],
    ] as const) {
      const point = {
        identifier: 1,
        target: frame,
        clientX:
          frame.getBoundingClientRect().left +
          frame.clientWidth * (0.75 - progress),
        clientY: 300,
      };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: [point] },
        changedTouches: { value: [point] },
      });
      frame.dispatchEvent(event);
    }
    return before;
  });
  await expect
    .poll(() =>
      pager.evaluate((node) => {
        const panel = node.querySelector<HTMLElement>(
          '[data-home-feed-panel="nearby"]',
        )!;
        return (
          panel.getBoundingClientRect().left - node.getBoundingClientRect().left
        );
      }),
    )
    .toBeLessThan(beforeCancelledDrag - 40);
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
  await pager.evaluate((node) => {
    const point = {
      identifier: 1,
      target: node,
      clientX: node.getBoundingClientRect().left + node.clientWidth * 0.15,
      clientY: 300,
    };
    const event = new Event("touchcancel", { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: [] },
      changedTouches: { value: [point] },
    });
    node.dispatchEvent(event);
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
  expect(
    await pager.evaluate((node) => {
      const panel = node.querySelector<HTMLElement>(
        '[data-home-feed-panel="nearby"]',
      )!;
      return Math.abs(
        panel.getBoundingClientRect().left - node.getBoundingClientRect().left,
      );
    }),
  ).toBeLessThanOrEqual(2);
});

test("MIG-C1 restores all-Calligraphy scroll and exact opener focus after Detail Back", async ({
  page,
}) => {
  const { calligraphy, surface } = await openSurface(page);
  await waitForInitialFeedScroll(homeSurface(surface));
  await expect
    .poll(async () => (await primaryScrollEvidence(surface)).maximum)
    .toBeGreaterThan(0);
  const recordedScroll = await writePrimaryScroll(surface, 180);
  expect(recordedScroll).toBeGreaterThan(0);
  const opener = calligraphy.locator(
    '[data-catalog-id="qa-visual-calligraphy-01"] [data-open-catalog]',
  );
  await opener.evaluate((button) => (button as HTMLButtonElement).click());
  const detail = productShell(surface).getByRole("dialog", {
    name: "资料详情",
  });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-source", "qa");
  expect(await page.evaluate(() => window.history.state.sourceScrollTop)).toBe(
    recordedScroll,
  );
  await detail.getByRole("button", { name: "返回" }).click();
  await expect(detail).toHaveCount(0);
  await expect(homeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    "calligraphy",
  );
  await expect
    .poll(async () => (await primaryScrollEvidence(surface)).top)
    .toBe(recordedScroll);
  await expect(opener).toBeFocused();

  await settleFeed(homeSurface(surface), "discover");
  await settleFeed(homeSurface(surface), "calligraphy");
  await expect
    .poll(async () => (await primaryScrollEvidence(surface)).top)
    .toBe(recordedScroll);
  await expect(calligraphy.locator("[data-catalog-card]")).toHaveCount(12);

  const shell = productShell(surface);
  if ((await shell.getAttribute("data-platform")) === "pc") return;
  await shell.locator("[data-user-trigger]").click();
  const userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await userPage.getByRole("button", { name: "打开设置" }).click();
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await settings.locator("[data-feed-layout-toggle]").click();
  await expect(shell).toHaveAttribute("data-feed-layout", "single");
  await settings.getByRole("button", { name: "返回" }).click();
  await userPage.getByRole("button", { name: "关闭用户页" }).click();
  await expect(userPage).toHaveCount(0);
  await expect(calligraphy.locator("[data-home-masonry]")).toHaveAttribute(
    "data-masonry-columns",
    "1",
  );
});

test("MIG-C1 preserves active Home feed and bounded scroll across resize and rotation", async ({
  page,
}) => {
  const { surface } = await openSurface(page);
  await waitForInitialFeedScroll(homeSurface(surface));
  await expect
    .poll(async () => (await primaryScrollEvidence(surface)).maximum)
    .toBeGreaterThan(0);
  const recordedScroll = await writePrimaryScroll(surface, 160);
  expect(recordedScroll).toBeGreaterThan(0);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Missing viewport size");
  const platform = await productShell(surface).getAttribute("data-platform");
  const resizedViewport =
    platform === "pc"
      ? {
          height: Math.max(720, viewport.height - 80),
          width: Math.max(1024, viewport.width - 160),
        }
      : { height: viewport.width, width: viewport.height };

  expect((await primaryScrollEvidence(surface)).top).toBe(recordedScroll);
  await page.setViewportSize(resizedViewport);
  await expect(homeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    "calligraphy",
  );

  await page.setViewportSize(viewport);
  await expect(homeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    "calligraphy",
  );
  await expect
    .poll(async () => {
      const evidence = await primaryScrollEvidence(surface);
      return Math.abs(evidence.top - recordedScroll);
    })
    .toBeLessThanOrEqual(2);
});

for (const chrome of ["default", "hidden"] as const) {
  test(`Controlled Home and user touch preserves vertical intent, interruption and native pinch (${chrome})`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Continuous trusted touch injection requires Chromium CDP; Safari physical input remains an Owner gate.",
    );
    const context = await browser.newContext({
      ...devices["iPhone 15"],
      baseURL: testInfo.project.use.baseURL as string,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const evidence: unknown[] = [];
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { id: number; x: number; y: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const move = async (
      from: { x: number; y: number },
      dx: number,
      dy: number,
    ) => {
      for (let step = 1; step <= 10; step++) {
        await touch("touchMove", [
          { id: 1, x: from.x + (dx * step) / 10, y: from.y + (dy * step) / 10 },
        ]);
        await page.waitForTimeout(16);
      }
    };
    try {
      for (const surface of [
        "discover",
        "inscriptions",
        "calligraphy",
        "user",
      ] as const) {
        await page.goto(
          chrome === "hidden" ? "/dev/t02p/qa?qaChrome=hidden" : "/dev/t02p/qa",
        );
        await expect(page.locator("[data-product-boot]")).toHaveCount(0);
        const home = page.locator("[data-home-surface]");
        if (surface === "user")
          await page.locator("[data-user-trigger]").click();
        else await settleFeed(home, surface);
        const frame = page.locator(
          surface === "user" ? "[data-user-pager]" : "[data-home-feed-pager]",
        );
        const panelSelector =
          surface === "user" ? "[data-user-panel]" : "[data-home-feed-panel]";
        const panels = frame.locator(panelSelector);
        const startIndex =
          surface === "inscriptions" ? 2 : surface === "calligraphy" ? 3 : 0;
        const direction = surface === "calligraphy" ? -1 : 1;
        const targetIndex = startIndex + direction;
        const scroller = panels.nth(startIndex);
        await expect(frame).toHaveCSS("touch-action", "pan-y pinch-zoom");
        if (surface !== "user") await waitForInitialFeedScroll(home, surface);
        const box = await frame.boundingBox();
        if (!box) throw new Error("Missing pager");
        const point = await frame.evaluate((node, dragDirection) => {
          const box = node.getBoundingClientRect();
          const x = box.x + box.width * (dragDirection === 1 ? 0.8 : 0.2);
          for (
            let y = Math.min(innerHeight - 120, box.bottom - 24);
            y > Math.max(box.top + 60, 240);
            y -= 16
          ) {
            if (node.contains(document.elementFromPoint(x, y))) return { x, y };
          }
          throw new Error(
            "No exposed pager point beneath the existing QA controls",
          );
        }, direction);
        await expect(frame).toHaveAttribute(
          "data-category-pager-engine",
          "embla",
        );
        const horizontalOffset = () =>
          frame.evaluate(
            (n) =>
              n.getBoundingClientRect().left -
              n.firstElementChild!.firstElementChild!.getBoundingClientRect()
                .left,
          );
        const initialOffset = await horizontalOffset();
        const beforeY = await scroller.evaluate((n) => n.scrollTop);
        await touch("touchStart", [{ id: 1, ...point }]);
        // A few initial diagonal pixels must not turn the following vertical
        // input into Home feed paging. Keep the original move cadence below.
        await touch("touchMove", [{ id: 1, x: point.x + 3, y: point.y + 2 }]);
        await move(point, -60, -180);
        await touch("touchEnd", []);
        await expect
          .poll(() => scroller.evaluate((n) => n.scrollTop))
          .toBeGreaterThan(beforeY + 20);
        expect(
          Math.abs((await horizontalOffset()) - initialOffset),
        ).toBeLessThanOrEqual(2);
        await expect(panels.nth(startIndex)).toHaveAttribute(
          "aria-hidden",
          "false",
        );
        // Observe actual release -> committed, interactive target. No scrollend synthesis.
        await frame.evaluate(
          (node, input) => {
            const f = node as HTMLElement;
            const data = {
              released: 0,
              committed: 0,
              trusted: 0,
              maximum: 0,
              commitCount: 0,
              remainingAtCommit: 0,
            };
            Object.assign(f, { controlledEvidence: data });
            f.addEventListener(
              "pointermove",
              (e) => {
                if (e.isTrusted) data.trusted++;
                data.maximum = Math.max(
                  data.maximum,
                  Math.abs(
                    f.getBoundingClientRect().left -
                      f.firstElementChild!.firstElementChild!.getBoundingClientRect()
                        .left -
                      input.initialOffset,
                  ),
                );
              },
              true,
            );
            f.addEventListener(
              "pointerup",
              () => {
                data.released = performance.now();
              },
              true,
            );
            const observer = new MutationObserver(() => {
              const target = f.querySelectorAll<HTMLElement>(input.selector)[
                input.targetIndex
              ];
              if (
                target &&
                !target.inert &&
                target.getAttribute("aria-hidden") === "false"
              ) {
                data.committed = performance.now();
                data.remainingAtCommit = Math.abs(
                  target.getBoundingClientRect().left -
                    f.getBoundingClientRect().left,
                );
                data.commitCount++;
                observer.disconnect();
              }
            });
            observer.observe(f, {
              subtree: true,
              attributes: true,
              attributeFilter: ["inert", "aria-hidden"],
            });
          },
          { selector: panelSelector, targetIndex, initialOffset },
        );
        await touch("touchStart", [{ id: 1, ...point }]);
        await move(point, -direction * 240, 4);
        expect(
          Math.abs((await horizontalOffset()) - initialOffset),
        ).toBeGreaterThan(100);
        await expect(panels.nth(startIndex)).toHaveAttribute(
          "aria-hidden",
          "false",
        );
        await touch("touchEnd", []);
        await expect(panels.nth(targetIndex)).toHaveAttribute(
          "aria-hidden",
          "false",
        );
        const timing = await frame.evaluate(
          (n) =>
            (
              n as HTMLElement & {
                controlledEvidence: {
                  released: number;
                  committed: number;
                  trusted: number;
                  maximum: number;
                  commitCount: number;
                  remainingAtCommit: number;
                };
              }
            ).controlledEvidence,
        );
        expect(timing.trusted).toBeGreaterThan(0);
        expect(timing.maximum).toBeGreaterThan(100);
        expect(timing.commitCount).toBe(1);
        expect(timing.committed - timing.released).toBeGreaterThanOrEqual(0);
        // The Home pager hands interaction over before its visual tail ends.
        expect(timing.remainingAtCommit).toBeGreaterThan(2);
        // A new opposite input during the next settle supersedes that animation.
        const reverse = {
          x: box.x + box.width * (direction === 1 ? 0.25 : 0.75),
          y: point.y,
        };
        await touch("touchStart", [{ id: 1, ...reverse }]);
        await move(reverse, direction * 220, 0);
        await touch("touchEnd", []);
        await touch("touchStart", [{ id: 1, ...point }]);
        await move(point, -direction * 240, 0);
        await touch("touchEnd", []);
        await expect(panels.nth(targetIndex)).toHaveAttribute(
          "aria-hidden",
          "false",
        );
        const committedLeft = await panels
          .nth(targetIndex)
          .evaluate((n) => (n as HTMLElement).offsetLeft);
        // Second finger joins an already controlled horizontal drag. Neither finger lifts before scale proof.
        await touch("touchStart", [{ id: 1, x: 150, y: point.y }]);
        await touch("touchMove", [{ id: 1, x: 120, y: point.y }]);
        const initialScale = await page.evaluate(() => visualViewport!.scale);
        await touch("touchStart", [
          { id: 1, x: 120, y: point.y },
          { id: 2, x: 210, y: point.y },
        ]);
        await expect(frame).toHaveAttribute(
          "data-horizontal-pager-scrolling",
          "false",
        );
        for (let step = 1; step <= 12; step++) {
          await touch("touchMove", [
            { id: 1, x: 120 - step * 4, y: point.y },
            { id: 2, x: 210 + step * 10, y: point.y },
          ]);
          await page.waitForTimeout(30);
        }
        await expect
          .poll(() => page.evaluate(() => visualViewport!.scale))
          .toBeGreaterThan(initialScale + 0.2);
        const afterScale = await page.evaluate(() => visualViewport!.scale);
        await touch("touchEnd", []);
        await expect(panels.nth(targetIndex)).toHaveAttribute(
          "aria-hidden",
          "false",
        );
        expect(
          Math.abs((await horizontalOffset()) - committedLeft),
        ).toBeLessThanOrEqual(2);
        await expect(page.locator("[data-quick-action-menu]")).toHaveCount(0);
        evidence.push({ surface, chrome, timing, initialScale, afterScale });
      }
    } finally {
      await testInfo.attach("controlled-pager-input", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      await context.close();
    }
  });
}

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { expect, test } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

const destinationAcceptance = {
  home: { label: "首页" },
  discussion: { label: "讨论" },
  user: { label: "用户" },
} as const;

type AcceptanceDestination = keyof typeof destinationAcceptance;
type AcceptancePlatform = "phone" | "tablet" | "pc";

const expectedInitialAutoPlatform = (
  projectName: string,
): AcceptancePlatform => {
  if (projectName === "mobile-webkit") return "phone";
  if (projectName.startsWith("tablet")) return "tablet";
  return "pc";
};

const platformSelector = (surface: Locator) =>
  surface.getByRole("combobox", { name: "QA presentation platform" });

const catalogScenarioSelector = (surface: Locator) =>
  surface.getByRole("combobox", { name: "QA Catalog scenario" });

const homeScenarioSelector = (surface: Locator) =>
  surface.getByRole("combobox", { name: "QA Home scenario" });

const productShell = (surface: Locator) =>
  surface.locator("[data-product-shell]");

const openSettingsThroughAvailableEntry = async (surface: Locator) => {
  const shell = productShell(surface);
  await expect(shell.locator("[data-open-settings]")).toHaveCount(0);
  await shell.locator("[data-user-trigger]").click();
  const userPage = shell.getByRole("dialog", { name: "用户页" });
  await expect(userPage).toBeVisible();
  await userPage.getByRole("button", { name: "打开设置" }).click();

  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  return { settings, userPage };
};

const closeSettingsAndUserPage = async (
  settings: Locator,
  userPage: Locator | null,
) => {
  await settings.getByRole("button", { name: "返回" }).click();
  await expect(settings).toHaveCount(0);
  if (userPage !== null) {
    await userPage.getByRole("button", { name: "关闭用户页" }).click();
    await expect(userPage).toHaveCount(0);
  }
};

const setFeedLayoutThroughSettings = async (
  surface: Locator,
  layout: "single" | "double",
) => {
  const shell = productShell(surface);
  if ((await shell.getAttribute("data-feed-layout")) === layout) return;

  const { settings, userPage } =
    await openSettingsThroughAvailableEntry(surface);
  const toggle = settings.locator("[data-feed-layout-toggle]");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(shell).toHaveAttribute("data-feed-layout", layout);
  await closeSettingsAndUserPage(settings, userPage);
};

const activeCatalogPresentation = (surface: Locator) =>
  surface.locator(
    '[data-primary-destination="home"]:not([hidden]) [data-home-feed-panel][aria-hidden="false"] :is([data-catalog-presentation], [data-calligraphy-all])',
  );

const activeHomeSurface = (surface: Locator) =>
  surface.locator(
    '[data-primary-destination="home"]:not([hidden]) [data-home-surface]',
  );

const activeHomeMasonry = (surface: Locator) =>
  activeHomeSurface(surface).locator(
    '[data-home-feed-panel="discover"] [data-home-masonry]',
  );

const activateHomeFeed = async (
  home: Locator,
  name: "发现" | "附近" | "碑刻" | "书帖",
) => {
  const feed = {
    发现: "discover",
    附近: "nearby",
    碑刻: "inscriptions",
    书帖: "calligraphy",
  }[name];
  await home
    .getByRole("tab", { name })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
};

type HomeFeedName = "discover" | "nearby" | "inscriptions" | "calligraphy";

const homeFeedIndex: Record<HomeFeedName, number> = {
  discover: 0,
  nearby: 1,
  inscriptions: 2,
  calligraphy: 3,
};

const touchSettleHomeFeed = async (home: Locator, feed: HomeFeedName) => {
  const pager = home.locator("[data-home-feed-pager]");
  // Each old scrollTo(auto) step was aligned before the next geometry input.
  // This setup helper waits for that actual position, not for interaction.
  const atPage = async (targetFeed: HomeFeedName) => {
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
        }, targetFeed),
      )
      .toBeLessThanOrEqual(2);
  };
  let active = (await home.getAttribute(
    "data-active-home-feed",
  )) as HomeFeedName;
  await atPage(active);
  while (active !== feed) {
    const direction = Math.sign(homeFeedIndex[feed] - homeFeedIndex[active]);
    const targetIndex = homeFeedIndex[active] + direction;
    const targetFeed = (Object.keys(homeFeedIndex) as HomeFeedName[]).find(
      (candidate) => homeFeedIndex[candidate] === targetIndex,
    );
    if (targetFeed === undefined) throw new Error("Missing adjacent Home feed");
    await pager.evaluate(
      (node, input) => {
        const frame = node as HTMLElement;
        const panel = frame.querySelector<HTMLElement>(
          `[data-home-feed-panel="${input.feed}"]`,
        );
        if (panel === null) throw new Error("Missing adjacent Home panel");
        for (const [type, progress] of [
          ["touchstart", 0],
          ["touchmove", 0.25],
          ["touchmove", 0.6],
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
                      clientX:
                        frame.clientWidth * (0.75 - input.direction * progress),
                      clientY: 300,
                    },
                  ],
          });
          frame.dispatchEvent(event);
        }
      },
      { feed: targetFeed, direction },
    );
    await expect(home).toHaveAttribute("data-active-home-feed", targetFeed);
    await atPage(targetFeed);
    active = targetFeed;
  }
};

const writeHomePanelScroll = async (
  home: Locator,
  feed: HomeFeedName,
  top: number,
) => {
  // Only the active panel owns scroll events in the shared Home pager.
  await touchSettleHomeFeed(home, feed);
  return home
    .locator(`[data-home-feed-panel="${feed}"]`)
    .evaluate((node, desiredTop) => {
      const panel = node as HTMLElement;
      panel.scrollTop = desiredTop;
      panel.dispatchEvent(new Event("scroll"));
      return panel.scrollTop;
    }, top);
};

const readHomePanelEvidence = async (home: Locator, feed: HomeFeedName) =>
  home.locator(`[data-home-feed-panel="${feed}"]`).evaluate((node) => {
    const panel = node as HTMLElement;
    const masonry = panel.querySelector<HTMLElement>("[data-home-masonry]");
    const anchor = masonry?.querySelector<HTMLElement>(
      "[data-home-masonry-item]",
    );
    const panelBox = panel.getBoundingClientRect();
    const masonryBox = masonry?.getBoundingClientRect();
    const anchorBox = anchor?.getBoundingClientRect();
    const items = Array.from(
      masonry?.querySelectorAll<HTMLElement>("[data-home-masonry-item]") ?? [],
    ).map((item) => {
      const box = item.getBoundingClientRect();
      return {
        bottom: masonryBox === undefined ? null : box.bottom - masonryBox.top,
        height: box.height,
        left: masonryBox === undefined ? null : box.left - masonryBox.left,
        top: masonryBox === undefined ? null : box.top - masonryBox.top,
        width: box.width,
      };
    });
    const images = Array.from(
      panel.querySelectorAll<HTMLImageElement>("img"),
    ).map((image) => ({
      complete: image.complete,
      currentSrc: image.currentSrc,
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
    }));
    const mediaStates = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "[data-catalog-media-state], [data-topic-cover-state]",
      ),
    ).map(
      (element) =>
        element.dataset.catalogMediaState ??
        element.dataset.topicCoverState ??
        "unknown",
    );
    const maxItemBottom = items.reduce(
      (maximum, item) => Math.max(maximum, item.bottom ?? 0),
      0,
    );
    const evidence = {
      activeFeed:
        panel.closest<HTMLElement>("[data-home-surface]")?.dataset
          .activeHomeFeed ?? null,
      anchorX: anchorBox === undefined ? null : anchorBox.x - panelBox.x,
      anchorY:
        anchorBox === undefined
          ? null
          : anchorBox.y - panelBox.y + panel.scrollTop,
      clientHeight: panel.clientHeight,
      layoutReady: masonry?.dataset.layoutReady ?? null,
      masonryColumns: masonry?.dataset.masonryColumns ?? null,
      masonryHeight: masonryBox?.height ?? null,
      masonryHeightMinusMaxItemBottom:
        masonryBox === undefined ? null : masonryBox.height - maxItemBottom,
      masonryWidth: masonryBox?.width ?? null,
      maxItemBottom,
      mediaStates,
      images,
      items,
      layoutRetained: masonry?.hasAttribute("data-layout-retained") ?? false,
      mediaTerminal: images.every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
      scrollTop: panel.scrollTop,
      testIdentity: panel.dataset.testScrollIdentity ?? null,
    };
    return {
      ...evidence,
      structuralSignature: JSON.stringify({
        activeFeed: evidence.activeFeed,
        anchorX: evidence.anchorX,
        anchorY: evidence.anchorY,
        images: evidence.images,
        items: evidence.items,
        layoutReady: evidence.layoutReady,
        layoutRetained: evidence.layoutRetained,
        masonryColumns: evidence.masonryColumns,
        masonryHeight: evidence.masonryHeight,
        masonryHeightMinusMaxItemBottom:
          evidence.masonryHeightMinusMaxItemBottom,
        masonryWidth: evidence.masonryWidth,
        mediaStates: evidence.mediaStates,
        scrollTop: evidence.scrollTop,
      }),
    };
  });

const waitForStableHomePanelEvidence = async (
  home: Locator,
  feed: HomeFeedName,
) => {
  const panel = home.locator(`[data-home-feed-panel="${feed}"]`);
  await panel.locator("img").evaluateAll((images) => {
    for (const image of images) (image as HTMLImageElement).loading = "eager";
  });
  let previousSignature: string | null = null;
  let stableFrameCount = 0;
  await expect
    .poll(
      async () => {
        await panel.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        const evidence = await readHomePanelEvidence(home, feed);
        const geometrySettled =
          evidence.masonryHeightMinusMaxItemBottom !== null &&
          Math.abs(evidence.masonryHeightMinusMaxItemBottom) <= 2;
        if (
          evidence.activeFeed !== feed ||
          evidence.layoutReady !== "true" ||
          evidence.layoutRetained ||
          !evidence.mediaTerminal ||
          !geometrySettled
        ) {
          previousSignature = null;
          stableFrameCount = 0;
          return false;
        }
        stableFrameCount =
          evidence.structuralSignature === previousSignature
            ? stableFrameCount + 1
            : 1;
        previousSignature = evidence.structuralSignature;
        return stableFrameCount >= 3;
      },
      // Each sample already awaits a real animation frame. Extra polling
      // backoff turns three frames into seconds on every restoration check.
      { timeout: 15_000, intervals: [0] },
    )
    .toBe(true);
  return readHomePanelEvidence(home, feed);
};

const settleHomeFeedAndReadStableEvidence = async (
  home: Locator,
  feed: HomeFeedName,
) => {
  await touchSettleHomeFeed(home, feed);
  return waitForStableHomePanelEvidence(home, feed);
};

const masonryItemContaining = (masonry: Locator, selector: string) =>
  masonry.locator(`[data-home-masonry-item]:has(${selector})`);

const requireBoundingBox = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a visible locator bounding box");
  return box;
};

const expectFeedCardGeometry = async ({
  columnCount,
  feed,
  fullCard,
  fullSpan,
  normalCard,
}: {
  readonly columnCount: number;
  readonly feed: Locator;
  readonly fullCard: Locator;
  readonly fullSpan: boolean;
  readonly normalCard: Locator;
}) => {
  if (fullSpan)
    await expect(fullCard).toHaveAttribute("data-home-masonry-span", "full");
  else
    await expect(fullCard).not.toHaveAttribute(
      "data-home-masonry-span",
      "full",
    );
  const [feedBox, fullCardBox, normalCardBox] = await Promise.all([
    requireBoundingBox(feed),
    requireBoundingBox(fullCard),
    requireBoundingBox(normalCard),
  ]);
  const columnGap = await feed
    .locator('[data-home-masonry-item]:not([data-home-masonry-span="full"])')
    .evaluateAll((nodes) => {
      const boxes = nodes
        .map((node) => node.getBoundingClientRect())
        .sort((a, b) => a.x - b.x);
      const left = boxes[0];
      const right = boxes.find((box) => left && box.x > left.x + 2);
      if (!left || !right)
        throw new Error("Expected two populated Masonry columns");
      return right.x - left.right;
    });
  expect(columnGap).toBeGreaterThan(0);
  const expectedColumnWidth =
    (feedBox.width - columnGap * Math.max(0, columnCount - 1)) / columnCount;

  expect(Math.abs(normalCardBox.width - expectedColumnWidth)).toBeLessThan(2);
  if (fullSpan) {
    expect(Math.abs(fullCardBox.x - feedBox.x)).toBeLessThan(2);
    expect(Math.abs(fullCardBox.width - feedBox.width)).toBeLessThan(2);
  } else {
    expect(Math.abs(fullCardBox.width - expectedColumnWidth)).toBeLessThan(2);
  }
};

const expectAlignedHomeFeatures = async (masonry: Locator) => {
  await expect(masonry).toHaveAttribute("data-layout-ready", "true");
  // Sample the parent and every item in one frame while the pager can move.
  const { items, box } = await masonry.evaluate((node) => ({
    box: node.getBoundingClientRect().toJSON(),
    items: Array.from(
      node.querySelectorAll("[data-home-masonry-item]"),
      (item) => {
        const box = item.getBoundingClientRect();
        return {
          full: item.getAttribute("data-home-masonry-span") === "full",
          x: box.x,
          y: box.y,
          width: box.width,
          bottom: box.bottom,
        };
      },
    ),
  }));
  expect(items.length).toBeGreaterThan(2);
  expect(items[0]!.full).toBe(true);
  let leftBottom = 0,
    rightBottom = 0;
  for (const [index, item] of items.entries()) {
    if (item.full) {
      expect(Math.abs(item.x - box.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(item.width - box.width)).toBeLessThanOrEqual(2);
      if (index > 0)
        expect(Math.abs(leftBottom - rightBottom)).toBeLessThanOrEqual(2);
      leftBottom = rightBottom = item.bottom;
    } else if (item.x < box.x + box.width / 4) leftBottom = item.bottom;
    else rightBottom = item.bottom;
  }
  expect(items[1]!.full).toBe(false);
  expect(items[2]!.full).toBe(false);
  expect(Math.abs(items[1]!.x - items[2]!.x)).toBeGreaterThan(
    items[1]!.width / 2,
  );
};

const expectCatalogCardsNotToOverlap = async (feed: Locator) => {
  expect(
    await feed.locator("[data-catalog-card]").evaluateAll((cards) => {
      const rectangles = cards.map((card) => card.getBoundingClientRect());

      return rectangles.every((rectangle, index) =>
        rectangles.slice(index + 1).every((candidate) => {
          const horizontalOverlap =
            Math.min(rectangle.right, candidate.right) -
            Math.max(rectangle.left, candidate.left);
          const verticalOverlap =
            Math.min(rectangle.bottom, candidate.bottom) -
            Math.max(rectangle.top, candidate.top);
          return horizontalOverlap <= 1 || verticalOverlap <= 1;
        }),
      );
    }),
  ).toBe(true);
};

const expectNoHorizontalOverflow = async (page: Page) => {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
};

const expectFeedToClearNavigation = async ({
  feed,
  navigation,
  page,
}: {
  readonly feed: Locator;
  readonly navigation: Locator;
  readonly page: Page;
}) => {
  await feed.evaluate((node) => {
    const destination = node.closest<HTMLElement>("[data-primary-destination]");
    const platform = node.closest<HTMLElement>("[data-product-shell]")?.dataset
      .platform;
    if (platform === "pc") {
      window.scrollTo(0, document.body.scrollHeight);
    } else if (destination !== null) {
      const scrollElement =
        destination.dataset.primaryDestination === "home"
          ? destination.querySelector<HTMLElement>(
              '[data-home-feed-panel][aria-hidden="false"]',
            )
          : destination;
      if (scrollElement !== null) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(50);
  const navigationBox = await requireBoundingBox(navigation);
  const finalCardBottom = await feed
    .locator("[data-catalog-card]")
    .evaluateAll((cards) =>
      Math.max(...cards.map((card) => card.getBoundingClientRect().bottom)),
    );

  expect(finalCardBottom).toBeLessThanOrEqual(navigationBox.y + 1);
};

const expectPresentationPlatform = async (
  surface: Locator,
  platform: AcceptancePlatform,
) => {
  await expect(productShell(surface)).toHaveAttribute(
    "data-platform",
    platform,
  );
  await expect(surface.locator("[data-primary-shell]")).toHaveAttribute(
    "data-platform",
    platform,
  );
  await expect(
    surface.getByRole("navigation", { name: "主要内容" }),
  ).toHaveAttribute("data-platform", platform);
};

const expectActiveDestination = async (
  surface: Locator,
  destination: AcceptanceDestination,
) => {
  const coordination = surface.locator("[data-primary-navigation-pager]");
  const shell = surface.locator("[data-primary-shell]");
  const navigation = surface.getByRole("navigation", { name: "主要内容" });

  await expect(productShell(surface)).toHaveAttribute(
    "data-active-destination",
    destination,
  );
  await expect(coordination).toHaveAttribute(
    "data-active-destination",
    destination,
  );
  await expect(shell).toHaveAttribute("data-active-destination", destination);
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(
    shell.locator("[data-primary-destination]:not([hidden])"),
  ).toHaveCount(1);
  const bubble = navigation.locator("[data-primary-navigation-bubble]");
  if ((await navigation.getAttribute("data-minimized")) === "true") {
    await expect(bubble).toBeHidden();
  } else {
    await expect(bubble).toBeVisible();
  }
  await expect(
    navigation.getByRole("button", {
      exact: true,
      name: destinationAcceptance[destination].label,
    }),
  ).toHaveAttribute("aria-current", "page");

  for (const candidate of Object.keys(
    destinationAcceptance,
  ) as AcceptanceDestination[]) {
    const section = shell.locator(`[data-primary-destination="${candidate}"]`);
    const active = candidate === destination;

    await expect(section).toHaveAttribute(
      "data-active",
      active ? "true" : "false",
    );
    if (active) {
      await expect(section).not.toHaveAttribute("hidden", "");
      await expect(section).toBeVisible();
      if (candidate === "home") {
        await expect(
          section.locator('[data-product-panel="home"] [data-home-surface]'),
        ).toBeVisible();
      } else if (candidate === "discussion") {
        await expect(
          section.locator(
            '[data-product-panel="discussion"] [data-discussion-surface]',
          ),
        ).toBeVisible();
      } else {
        await expect(
          section.getByRole("heading", { name: "用户", exact: true }),
        ).toBeVisible();
      }
    } else {
      await expect(section).toHaveAttribute("hidden", "");
      await expect(section).toBeHidden();
    }
  }
};

const expectActiveHomeFeed = async (surface: Locator, feed: HomeFeedName) => {
  await expectActiveDestination(surface, "home");
  await expect(activeHomeSurface(surface)).toHaveAttribute(
    "data-active-home-feed",
    feed,
  );
  await expect(
    activeHomeSurface(surface).locator(`[data-home-feed-panel="${feed}"]`),
  ).toHaveAttribute("aria-hidden", "false");
};
const activeDiscussionSurface = (surface: Locator) =>
  surface.locator(
    '[data-primary-destination="discussion"]:not([hidden]) [data-discussion-surface]',
  );
const openDiscussionTopics = async (surface: Locator) => {
  await surface
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "讨论", exact: true })
    .click();
  await expectActiveDestination(surface, "discussion");
  const discussion = activeDiscussionSurface(surface);
  await discussion.getByRole("tab", { name: "专题", exact: true }).click();
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(discussion.locator("#discussion-panel-topics")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  return discussion;
};

const pagerAction = (surface: Locator, action: "previous" | "next") =>
  surface.locator(`[data-primary-pager-action="${action}"]`);

const activatePagerAction = async (
  surface: Locator,
  action: "previous" | "next",
) => {
  const button = pagerAction(surface, action);
  await expect(button).toBeEnabled();
  await button.evaluate((element) => (element as HTMLButtonElement).click());
};

const locatorCenter = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a visible locator bounding box");

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
};

const trackPointerCaptureCalls = async (button: Locator) => {
  await button.evaluate((element) => {
    const captureButton = element as HTMLButtonElement;
    const setPointerCapture =
      captureButton.setPointerCapture.bind(captureButton);
    const releasePointerCapture =
      captureButton.releasePointerCapture.bind(captureButton);

    captureButton.dataset.testSetPointerCaptureCount = "0";
    captureButton.dataset.testReleasePointerCaptureCount = "0";
    captureButton.setPointerCapture = (pointerId) => {
      captureButton.dataset.testSetPointerCaptureCount = String(
        Number(captureButton.dataset.testSetPointerCaptureCount) + 1,
      );
      setPointerCapture(pointerId);
    };
    captureButton.releasePointerCapture = (pointerId) => {
      captureButton.dataset.testReleasePointerCaptureCount = String(
        Number(captureButton.dataset.testReleasePointerCaptureCount) + 1,
      );
      releasePointerCapture(pointerId);
    };
  });
};

const openDevelopmentSurface = async (page: Page) => {
  const response = await page.goto("/dev/t02p/qa");
  expect(response?.status()).toBe(200);

  const surface = page.locator("[data-t02p-qa-harness]");
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await expect(activeHomeMasonry(surface)).toHaveAttribute(
    "data-layout-ready",
    "true",
  );

  return {
    navigation: surface.getByRole("navigation", { name: "主要内容" }),
    surface,
  };
};

const openCleanProductSurface = async (page: Page) => {
  const response = await page.goto("/dev/t02p?acceptance=r01-clean");
  expect(response?.status()).toBe(200);

  const surface = page.locator("[data-clean-product-preview]");
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);

  return {
    navigation: surface.getByRole("navigation", { name: "主要内容" }),
    surface,
  };
};

const writePrimaryScroll = async (
  shell: Locator,
  destination: AcceptanceDestination,
  top: number,
) =>
  shell.evaluate(
    (node, input) => {
      const product = node as HTMLElement;
      const section = product.querySelector<HTMLElement>(
        `[data-primary-destination="${input.destination}"]`,
      );
      if (section === null) throw new Error("Missing primary destination");
      if (product.dataset.platform === "pc") {
        window.scrollTo(0, input.top);
        return document.scrollingElement?.scrollTop ?? window.scrollY;
      }
      const scrollElement =
        input.destination === "home"
          ? section.querySelector<HTMLElement>(
              '[data-home-feed-panel][aria-hidden="false"]',
            )
          : input.destination === "discussion"
            ? section.querySelector<HTMLElement>(
                '[role="tabpanel"][aria-hidden="false"]',
              )
            : section;
      if (scrollElement === null) throw new Error("Missing scroll element");
      scrollElement.scrollTop = input.top;
      return scrollElement.scrollTop;
    },
    { destination, top },
  );

const readPrimaryScroll = async (
  shell: Locator,
  destination: AcceptanceDestination,
) =>
  shell.evaluate((node, targetDestination) => {
    const product = node as HTMLElement;
    if (product.dataset.platform === "pc") {
      return document.scrollingElement?.scrollTop ?? window.scrollY;
    }
    const section = product.querySelector<HTMLElement>(
      `[data-primary-destination="${targetDestination}"]`,
    );
    if (section === null) return 0;
    return targetDestination === "home"
      ? (section.querySelector<HTMLElement>(
          '[data-home-feed-panel][aria-hidden="false"]',
        )?.scrollTop ?? 0)
      : targetDestination === "discussion"
        ? (section.querySelector<HTMLElement>(
            '[role="tabpanel"][aria-hidden="false"]',
          )?.scrollTop ?? 0)
        : section.scrollTop;
  }, destination);

const confirmMouseNavigationReady = async (
  surface: Locator,
  navigation: Locator,
) => {
  await expect
    .poll(async () => {
      await navigation
        .getByRole("button", { exact: true, name: "讨论" })
        .click();
      return productShell(surface).getAttribute("data-active-destination");
    })
    .toBe("discussion");
  await expectActiveDestination(surface, "discussion");
  await expect
    .poll(async () => {
      await navigation
        .getByRole("button", { exact: true, name: "首页" })
        .click();
      return productShell(surface).getAttribute("data-active-destination");
    })
    .toBe("home");
  await expectActiveDestination(surface, "home");
};

const ensurePrimaryNavigationExpanded = async (navigation: Locator) => {
  if ((await navigation.getAttribute("data-minimized")) !== "true") return;
  await navigation
    .locator('[data-primary-navigation-destination][aria-current="page"]')
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(navigation).toHaveAttribute("data-minimized", "false");
};

test("Clean Product Preview preserves shell state, scroll, and preferences set through QA User Settings", async ({
  page,
}, testInfo) => {
  const { surface: qa } = await openDevelopmentSurface(page);
  const { settings, userPage } = await openSettingsThroughAvailableEntry(qa);
  await expect(settings.getByRole("button", { name: "返回" })).toBeFocused();
  await settings.getByRole("button", { name: /切换主题/ }).click();
  await expect(productShell(qa)).toHaveAttribute(
    "data-theme-preference",
    "light",
  );
  if (expectedInitialAutoPlatform(testInfo.project.name) === "pc") {
    await expect(settings.locator("[data-feed-layout-toggle]")).toHaveCount(0);
  } else {
    await settings.locator("[data-feed-layout-toggle]").click();
    await expect(productShell(qa)).toHaveAttribute(
      "data-feed-layout",
      "single",
    );
  }
  await closeSettingsAndUserPage(settings, userPage);
  const response = await page.goto("/dev/t02p?acceptance=r01-clean");
  expect(response?.status()).toBe(200);

  const preview = page.locator("[data-clean-product-preview]");
  const shell = preview.locator("[data-product-shell]");
  const navigation = preview.getByRole("navigation", { name: "主要内容" });
  await expect(preview).toBeVisible();
  await expect(shell).toHaveAttribute(
    "data-platform",
    expectedInitialAutoPlatform(testInfo.project.name),
  );
  await expect(preview.locator("[data-qa-controls]")).toHaveCount(0);
  await expect(preview.locator("[data-development-primary-pager]")).toHaveCount(
    0,
  );
  await expect(preview).not.toContainText("T02P QA Harness");
  await expect(preview.locator("[data-product-boot]")).toHaveCount(0);
  await expect(
    preview.locator(
      "[data-open-settings], [data-search-trigger], [data-user-trigger]",
    ),
  ).toHaveCount(0);
  await expect(shell).toHaveAttribute("data-theme-preference", "light");

  const homeScroll = await writePrimaryScroll(shell, "home", 180);
  expect(homeScroll).toBeGreaterThanOrEqual(0);
  await navigation.getByRole("button", { exact: true, name: "讨论" }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "discussion");
  const discussionScroll = await writePrimaryScroll(shell, "discussion", 130);
  expect(discussionScroll).toBeGreaterThanOrEqual(0);
  await navigation.getByRole("button", { exact: true, name: "用户" }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "user");
  await writePrimaryScroll(shell, "user", 60);
  await navigation.getByRole("button", { exact: true, name: "首页" }).click();
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  await expect
    .poll(() => readPrimaryScroll(shell, "home"))
    .toBeGreaterThanOrEqual(homeScroll - 1);

  await expect(page).toHaveURL(/\/dev\/t02p\?acceptance=r01-clean$/u);

  await page.reload();
  const reloadedShell = page.locator("[data-product-shell]");
  await expect(reloadedShell).toHaveAttribute("data-theme-preference", "light");
  await expect(reloadedShell).toHaveAttribute(
    "data-feed-layout",
    expectedInitialAutoPlatform(testInfo.project.name) === "pc"
      ? "double"
      : "single",
  );
});

test("Direct Settings history has a safe Back and Forward path", async ({
  page,
}) => {
  const response = await page.goto("/dev/t02p?acceptance=r01-direct#settings");
  expect(response?.status()).toBe(200);
  const shell = page.locator("[data-product-shell]");
  const settings = shell.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();

  await settings.getByRole("button", { name: "返回" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page).toHaveURL(/\/dev\/t02p\?acceptance=r01-direct$/u);

  await page.goForward();
  await expect(shell.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("MIG-D1 opens one runtime Detail architecture from Home, Inscriptions, and Calligraphy", async ({
  page,
}) => {
  const response = await page.goto("/dev/t02p?acceptance=mig-d1-runtime");
  expect(response?.status()).toBe(200);
  const preview = page.locator("[data-clean-product-preview]");
  const shell = productShell(preview);
  const navigation = preview.getByRole("navigation", { name: "主要内容" });
  const detail = shell.getByRole("dialog", { name: "资料详情" });

  const openAndReturn = async (catalogId: string, title: string) => {
    const opener = shell
      .locator(
        '[data-primary-destination="home"] [data-home-feed-panel][aria-hidden="false"]',
      )
      .locator(`[data-catalog-id="${catalogId}"] [data-open-catalog]`);
    await opener.click();
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute("data-detail-source", "runtime");
    await expect(detail.locator("[data-detail-title]"), title).toBeVisible();
    if (catalogId === "runtime-inscription-no-media") {
      await expect(
        detail.locator(
          '[data-detail-section="transcription"], [data-detail-section="historicalContext"], [data-detail-section="scholarlyResearch"]',
        ),
      ).toHaveCount(0);
    }
    await expect(shell.locator("[data-product-primary-layer]")).toHaveAttribute(
      "inert",
      "",
    );
    await expect(detail.getByRole("button", { name: "返回" })).toBeFocused();
    await detail.getByRole("button", { name: "返回" }).click();
    await expect(detail).toHaveCount(0);
    await expect(opener).toBeFocused();
  };

  await openAndReturn("runtime-inscription-no-media", "运行时无图碑刻");
  await ensurePrimaryNavigationExpanded(navigation);
  await activateHomeFeed(activeHomeSurface(preview), "碑刻");
  await expectActiveHomeFeed(preview, "inscriptions");
  await openAndReturn("runtime-inscription-multi-media", "运行时多图碑刻");
  await ensurePrimaryNavigationExpanded(navigation);
  await activateHomeFeed(activeHomeSurface(preview), "书帖");
  await expectActiveHomeFeed(preview, "calligraphy");
  await openAndReturn("runtime-calligraphy", "运行时书帖");

  await expect(shell.locator("[data-detail-experience]")).toHaveCount(0);
  await expect(preview.locator("[data-qa-controls]")).toHaveCount(0);
});

test("MIG-D1 direct multi-media Detail preserves Carousel and scroll across resize and Back/Forward", async ({
  page,
}) => {
  const response = await page.goto(
    "/dev/t02p?catalogId=runtime-inscription-multi-media",
  );
  expect(response?.status()).toBe(200);
  const shell = page.locator("[data-product-shell]");
  const detail = shell.getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-source", "runtime");
  await expect(detail.locator("[data-detail-media-dot]")).toHaveCount(2);
  await expect(detail.locator("[data-detail-media-index]")).toContainText(
    "1 / 2",
  );
  await expect(detail.getByText("运行时撰文者", { exact: true })).toBeVisible();
  await expect(detail.getByText("运行时书者", { exact: true })).toBeVisible();
  await expect(
    detail.getByText("碑额篆书，正文楷书", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.locator("[data-detail-facts]"),
    "periodLabel de-dup",
  ).not.toContainText(/朝代|年代/u);
  // Mission 2C composes the live comment section here too: on pc and
  // tablet-landscape the accepted layout folds the reading flow behind 详情,
  // so open it before reading the sections it holds.
  const disclosure = detail.locator("[data-detail-reading-disclosure]");
  if (
    (await disclosure.count()) > 0 &&
    (await disclosure.getAttribute("open")) === null
  )
    await disclosure.locator("summary").click();
  await expect(
    detail.getByText("用于验证多媒体与响应式连续性。", { exact: true }),
  ).toHaveCount(1);
  const sectionOrder = await detail
    .locator("[data-detail-section]")
    .evaluateAll((sections) =>
      sections.map((section) =>
        (section as HTMLElement).getAttribute("data-detail-section"),
      ),
    );
  expect(sectionOrder).toEqual([
    "description",
    "transcription",
    "historicalContext",
    "scholarlyResearch",
    "sources",
  ]);
  const transcription = detail.locator(
    '[data-detail-section="transcription"] p',
  );
  await expect(transcription).toHaveText("运行时释文第一行\n运行时释文第二行");
  await expect(transcription).toHaveCSS("white-space", "pre-wrap");
  await expect(
    detail.getByText("适用于：整体资料", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("适用于：释文、历史背景", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("测试公开资料", { exact: true })).toHaveCount(
    1,
  );
  await expect(detail.getByText("测试分区资料", { exact: true })).toHaveCount(
    1,
  );
  await expect(detail).not.toContainText("QA 合成");

  const stage = detail.locator("[data-detail-main-stage]");
  const box = await stage.boundingBox();
  if (box === null) throw new Error("Missing Detail Carousel geometry");
  const startX = box.x + box.width * 0.62;
  const endX = box.x + box.width * 0.38;
  const centerY = box.y + box.height * 0.5;
  await stage.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: centerY,
    isPrimary: true,
    pointerId: 301,
    pointerType: "touch",
  });
  await stage.dispatchEvent("pointermove", {
    button: 0,
    buttons: 1,
    clientX: endX,
    clientY: centerY,
    isPrimary: true,
    pointerId: 301,
    pointerType: "touch",
  });
  await stage.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    clientX: endX,
    clientY: centerY,
    isPrimary: true,
    pointerId: 301,
    pointerType: "touch",
  });
  await expect(detail.locator("[data-detail-media-index]")).toContainText(
    "2 / 2",
  );

  const scroller = shell.locator("[data-detail-scroll]");
  // The index records intent before native smooth paging reaches its target.
  // Resize the completed page, not an in-flight synthetic swipe.
  await expect
    .poll(() =>
      stage.evaluate((node) => {
        const element = node as HTMLElement;
        if (
          element.closest<HTMLElement>("[data-product-shell]")?.dataset
            .platform === "pc"
        )
          return true;
        return (
          element.clientWidth > 0 &&
          Math.abs(element.scrollLeft - element.clientWidth) <= 1
        );
      }),
    )
    .toBe(true);
  const recordedScroll = await scroller.evaluate((node) => {
    const element = node as HTMLElement;
    element.scrollTop = Math.min(
      180,
      Math.max(0, element.scrollHeight - element.clientHeight),
    );
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  expect(recordedScroll).toBeGreaterThan(0);
  await expect
    .poll(() => scroller.evaluate((node) => (node as HTMLElement).scrollTop))
    .toBe(recordedScroll);
  await expect
    .poll(() =>
      page.evaluate(() =>
        typeof history.state === "object" && history.state !== null
          ? (history.state as { detailScrollTop?: number }).detailScrollTop
          : undefined,
      ),
    )
    .toBe(recordedScroll);

  const viewport = page.viewportSize();
  if (viewport !== null) {
    await page.setViewportSize({
      height: viewport.width,
      width: viewport.height,
    });
    await expect(detail.locator("[data-detail-media-index]")).toContainText(
      "2 / 2",
    );
    await page.setViewportSize(viewport);
  }
  // A layout change re-mounts the wide layout with 详情 folded again, so the
  // scroller may be shorter than the remembered position: the position is
  // kept (history) and applied as far as the content reaches.
  await expect
    .poll(() =>
      scroller.evaluate((node, desiredTop) => {
        const element = node as HTMLElement;
        const maximum = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        return Math.abs(element.scrollTop - Math.min(desiredTop, maximum)) <= 2;
      }, recordedScroll),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        typeof history.state === "object" && history.state !== null
          ? (history.state as { detailScrollTop?: number }).detailScrollTop
          : undefined,
      ),
    )
    .toBe(recordedScroll);

  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(page).toHaveURL(/\/dev\/t02p$/u);
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-detail-media-index]")).toContainText(
    "1 / 2",
  );
  await expect
    .poll(() =>
      shell.locator("[data-detail-scroll]").evaluate((node, desiredTop) => {
        const element = node as HTMLElement;
        const maximum = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        return Math.abs(element.scrollTop - Math.min(desiredTop, maximum)) <= 2;
      }, recordedScroll),
    )
    .toBe(true);
});

test("MIG-D1 QA direct entry keeps Catalog identity and a truthful no-media state", async ({
  page,
}) => {
  const response = await page.goto(
    "/dev/t02p/qa?catalogId=qa-visual-inscription-09",
  );
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  const detail = productShell(surface).getByRole("dialog", {
    name: "资料详情",
  });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-source", "qa");
  await expect(detail.locator("[data-detail-title]")).toHaveText(
    "无图碑刻甲（视觉 QA 合成）",
  );
  await expect(
    detail.locator('[data-detail-media-state="missing"]'),
  ).toBeVisible();
  await expect(detail).toContainText("暂无公开图像");
  await expect(detail).not.toContainText("重试");
  await detail.getByRole("button", { name: "返回" }).click();
  await expect(detail).toHaveCount(0);
});

test("Development QA Harness observes the shared Product Shell without owning it", async ({
  page,
}, testInfo) => {
  const response = await page.goto("/dev/t02p/qa");
  expect(response?.status()).toBe(200);

  const surface = page.locator("[data-t02p-qa-harness]");
  await expect(surface).toBeVisible();
  const navigation = surface.getByRole("navigation", { name: "主要内容" });
  await expect(navigation).toBeVisible();
  await expect(surface.locator("[data-primary-navigation-dock]")).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(navigation).toHaveCSS("position", "relative");
  await expect(
    navigation.locator("[data-primary-navigation-destination]"),
  ).toHaveCount(3);
  await expect(
    navigation.locator(
      '[data-primary-navigation-destination="upload"], [data-primary-navigation-destination="profile"]',
    ),
  ).toHaveCount(0);
  await expect(
    surface.locator(
      '[data-yoyi-ui="desktop-navigation"], .yoyi-desktop-navigation',
    ),
  ).toHaveCount(0);
  await expect(catalogScenarioSelector(surface)).toHaveValue("visual");
  await expect(surface).toHaveAttribute("data-catalog-scenario", "visual");
  await expectActiveDestination(surface, "home");
  await expect(
    activeHomeSurface(surface).locator(
      '[data-home-feed-panel="discover"] [data-catalog-card]',
    ),
  ).toHaveCount(24);
  await expect(pagerAction(surface, "previous")).toBeDisabled();
  for (const [label, feed] of [
    ["碑刻", "inscriptions"],
    ["书帖", "calligraphy"],
  ] as const) {
    await activateHomeFeed(activeHomeSurface(surface), label);
    await expectActiveHomeFeed(surface, feed);
    await expect(
      activeCatalogPresentation(surface).locator("[data-catalog-card]"),
    ).toHaveCount(12);
  }
  await activateHomeFeed(activeHomeSurface(surface), "发现");

  await expect
    .poll(async () => {
      await navigation
        .getByRole("button", { name: "讨论", exact: true })
        .click();
      return productShell(surface).getAttribute("data-active-destination");
    })
    .toBe("discussion");
  await expectActiveDestination(surface, "discussion");
  await expect(activeDiscussionSurface(surface).getByRole("tab")).toHaveText([
    "近闻",
    "话题",
    "专题",
  ]);

  await navigation.getByRole("button", { name: "用户", exact: true }).click();
  await expectActiveDestination(surface, "user");
  await expect(
    surface
      .locator('[data-primary-destination="user"]')
      .getByText("登录后查看个人主页。"),
  ).toBeVisible();
  await expect(pagerAction(surface, "next")).toBeDisabled();

  await activatePagerAction(surface, "previous");
  await expectActiveDestination(surface, "discussion");
  await activatePagerAction(surface, "previous");
  await expectActiveDestination(surface, "home");
  await expect(pagerAction(surface, "previous")).toBeDisabled();

  await activatePagerAction(surface, "next");
  await expectActiveDestination(surface, "discussion");

  const qaPlatformSelector = platformSelector(surface);
  await expect(qaPlatformSelector).toHaveValue("auto");
  await expectPresentationPlatform(
    surface,
    expectedInitialAutoPlatform(testInfo.project.name),
  );
  await qaPlatformSelector.selectOption("phone");
  await expectPresentationPlatform(surface, "phone");
  await expect(navigation).toBeVisible();
  await expectActiveDestination(surface, "discussion");

  await qaPlatformSelector.selectOption("tablet");
  await expectPresentationPlatform(surface, "tablet");
  await expect(navigation).toBeVisible();
  await expectActiveDestination(surface, "discussion");

  await qaPlatformSelector.selectOption("pc");
  await expectPresentationPlatform(surface, "pc");
  await expectActiveDestination(surface, "discussion");

  await qaPlatformSelector.selectOption("auto");
  await expectPresentationPlatform(
    surface,
    expectedInitialAutoPlatform(testInfo.project.name),
  );
  await expectActiveDestination(surface, "discussion");
});

test("Home tabs remain internal to Home and expose the four R2 feeds", async ({
  page,
}) => {
  const { surface } = await openDevelopmentSurface(page);
  const home = activeHomeSurface(surface);
  const shell = productShell(surface);
  const urlBefore = page.url();
  const tabs = home.getByRole("tab");

  await expect(tabs).toHaveCount(4);
  await expect(tabs).toHaveText(["发现", "附近", "碑刻", "书帖"]);
  await expect(home.locator('[role="tab"][aria-selected="true"]')).toHaveCount(
    1,
  );
  await expect(home.locator('[role="tabpanel"]')).toHaveCount(4);

  await activateHomeFeed(home, "附近");
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
  await expect(home.locator('[data-home-feed-panel="nearby"]')).toBeVisible();
  await expect(
    home.locator('[data-home-feed-panel="discover"]'),
  ).toHaveAttribute("aria-hidden", "true");
  await expect(
    home.locator('[data-home-feed-panel="discover"]'),
  ).toHaveAttribute("inert", "");
  await expect(shell).toHaveAttribute("data-active-destination", "home");
  expect(page.url()).toBe(urlBefore);

  for (const [label, feed] of [
    ["碑刻", "inscriptions"],
    ["书帖", "calligraphy"],
  ] as const) {
    await activateHomeFeed(home, label);
    await expectActiveHomeFeed(surface, feed);
    await expect(
      activeCatalogPresentation(surface).locator("[data-catalog-card]"),
    ).toHaveCount(12);
    expect(page.url()).toBe(urlBefore);
  }
  await expect(home.locator("[data-topic-card]")).toHaveCount(0);
  const discussion = await openDiscussionTopics(surface);
  await expect(discussion.locator("[data-topic-card]")).toHaveCount(7);
});

test("Home pager follows touch progress and hands interaction over on release", async ({
  page,
}, testInfo) => {
  test.skip(
    expectedInitialAutoPlatform(testInfo.project.name) === "pc",
    "The internal touch pager runs on Phone and Tablet; PC has a separate wheel path.",
  );
  const { surface } = await openDevelopmentSurface(page);
  const home = activeHomeSurface(surface);
  const pager = home.locator("[data-home-feed-pager]");
  const discover = home.locator('[data-home-feed-panel="discover"]');
  const nearby = home.locator('[data-home-feed-panel="nearby"]');
  const indicator = home.locator("[data-top-tab-indicator]");

  await expect(pager).toHaveAttribute("data-category-pager-engine", "embla");
  await expect(pager).toHaveCSS("scroll-snap-type", "none");
  // Horizontal input is local; browser vertical scrolling and pinch remain enabled.
  await expect(pager).toHaveCSS("touch-action", "pan-y pinch-zoom");
  await expect(nearby).not.toHaveAttribute("hidden", "");
  await expect(
    home.locator('[data-home-feed-panel="calligraphy"]'),
  ).not.toHaveAttribute("hidden", "");
  const sourceHeight = await pager.evaluate(
    (node) => (node as HTMLElement).style.height,
  );
  const beforeDiscover = await requireBoundingBox(discover);
  const beforeNearby = await requireBoundingBox(nearby);

  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    // Controlled touch delivery checks integration; the native-input suite
    // separately verifies browser scrolling, pinch and gesture arbitration.
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.5],
    ] as const) {
      const point = {
        identifier: 1,
        target: frame,
        clientX: frame.clientWidth * (0.75 - progress),
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
  await expect(pager).toHaveAttribute("data-home-pager-scrolling", "true");
  await expect
    .poll(async () =>
      home
        .getByRole("tab", { name: "附近", exact: true })
        .evaluate((node) =>
          Number(
            (node as HTMLElement).style.getPropertyValue(
              "--top-tab-activation",
            ),
          ),
        ),
    )
    .toBeCloseTo(0.5, 1);
  await expect
    .poll(async () => {
      const [line, first, second] = await Promise.all([
        requireBoundingBox(indicator),
        requireBoundingBox(
          home.getByRole("tab", { name: "发现", exact: true }),
        ),
        requireBoundingBox(
          home.getByRole("tab", { name: "附近", exact: true }),
        ),
      ]);
      return Math.abs(line.x - (first.x + second.x) / 2);
    })
    .toBeLessThanOrEqual(2);
  expect(
    await pager.evaluate((node) => (node as HTMLElement).style.height),
  ).toBe(sourceHeight);
  const duringDiscover = await requireBoundingBox(discover);
  const duringNearby = await requireBoundingBox(nearby);
  expect(duringDiscover.x).toBeLessThan(beforeDiscover.x);
  expect(duringNearby.x).toBeLessThan(beforeNearby.x);
  await expect(productShell(surface)).toHaveAttribute(
    "data-active-destination",
    "home",
  );

  const release = await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    const point = {
      identifier: 1,
      target: frame,
      clientX: -frame.clientWidth * 0.25,
      clientY: 300,
    };
    for (const type of ["touchmove", "touchend"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchmove" ? [point] : [] },
        changedTouches: { value: [point] },
      });
      frame.dispatchEvent(event);
    }
    const target = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="nearby"]',
    )!;
    return {
      active: frame.closest<HTMLElement>("[data-home-surface]")!.dataset
        .activeHomeFeed,
      inert: target.inert,
      remaining: Math.abs(
        target.getBoundingClientRect().left -
          frame.getBoundingClientRect().left,
      ),
    };
  });
  expect(release.active).toBe("nearby");
  expect(release.inert).toBe(false);
  expect(release.remaining).toBeGreaterThan(2);
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
  await expect(pager).toHaveAttribute("data-home-pager-scrolling", "false");
  await expect(nearby).toHaveAttribute("aria-hidden", "false");
  await expect(discover).toHaveAttribute("aria-hidden", "true");
  await expect(home.getByRole("tab", { name: "附近" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(productShell(surface)).toHaveAttribute(
    "data-active-destination",
    "home",
  );
});

test("Home touch release commits once without post-release programmatic drift", async ({
  page,
}, testInfo) => {
  test.skip(
    expectedInitialAutoPlatform(testInfo.project.name) === "pc",
    "The touch release ownership regression belongs to Phone and Tablet.",
  );
  const { surface } = await openDevelopmentSurface(page);
  const home = activeHomeSurface(surface);
  const pager = home.locator("[data-home-feed-pager]");
  await expect(pager).toHaveAttribute("data-category-pager-engine", "embla");

  await pager.evaluate((node) => {
    const frame = node as HTMLElement & {
      __r03NativeSettleEvidence?: {
        activeFeedChanges: string[];
        programmaticScrolls: number[];
      };
    };
    const evidence = {
      activeFeedChanges: [] as string[],
      programmaticScrolls: [] as number[],
    };
    frame.__r03NativeSettleEvidence = evidence;
    const nativeScrollTo = frame.scrollTo.bind(frame);
    frame.scrollTo = ((optionsOrX?: ScrollToOptions | number, y?: number) => {
      const left =
        typeof optionsOrX === "number"
          ? optionsOrX
          : Number(optionsOrX?.left ?? frame.scrollLeft);
      evidence.programmaticScrolls.push(left);
      if (typeof optionsOrX === "number") nativeScrollTo(optionsOrX, y ?? 0);
      else nativeScrollTo(optionsOrX);
    }) as typeof frame.scrollTo;
    const homeSurface = frame.closest<HTMLElement>("[data-home-surface]");
    if (homeSurface === null) throw new Error("Missing Home surface");
    new MutationObserver(() => {
      evidence.activeFeedChanges.push(
        homeSurface.dataset.activeHomeFeed ?? "missing",
      );
    }).observe(homeSurface, {
      attributeFilter: ["data-active-home-feed"],
    });
  });

  const feeds = ["discover", "nearby", "inscriptions", "calligraphy"] as const;
  const expectSettledFeed = async (feed: (typeof feeds)[number]) => {
    // Confirm the full visual tail before the short out-and-back gesture;
    // ordinary repeated releases below can still interrupt a moving tail.
    await expect
      .poll(
        () =>
          pager.evaluate(async (node, targetFeed) => {
            const frame = node as HTMLElement;
            const panel = frame.querySelector<HTMLElement>(
              `[data-home-feed-panel="${targetFeed}"]`,
            );
            if (panel === null) throw new Error("Missing settled Home panel");
            const settled = () =>
              frame.dataset.homePagerScrolling === "false" &&
              Math.abs(
                panel.getBoundingClientRect().left -
                  frame.getBoundingClientRect().left,
              ) < 1;
            if (!settled()) return false;
            // Check consecutive animation frames, including the first scroll frame
            // where an initially false motion attribute alone would be misleading.
            for (let index = 0; index < 2; index += 1) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              if (!settled()) return false;
            }
            return true;
          }, feed),
        { intervals: [16] },
      )
      .toBe(true);
    await expect(home).toHaveAttribute("data-active-home-feed", feed);
  };
  let currentIndex = 0;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const direction =
      Math.floor(iteration / (feeds.length - 1)) % 2 === 0 ? 1 : -1;
    const targetIndex = currentIndex + direction;
    const targetFeed = feeds[targetIndex];
    if (targetFeed === undefined) throw new Error("Missing Home feed target");
    // Wait for the committed panel to cross its final quarter-width, while
    // retaining the animation tail. A reverse gesture must start from the
    // selected panel's side of the midpoint, not from its previous neighbor.
    await expect
      .poll(
        () =>
          pager.evaluate((node, sourceIndex) => {
            const source = node.querySelectorAll("[data-home-feed-panel]")[
              sourceIndex
            ];
            if (source === undefined)
              throw new Error("Missing current Home panel");
            return (
              Math.abs(
                source.getBoundingClientRect().left -
                  node.getBoundingClientRect().left,
              ) / node.clientWidth
            );
          }, currentIndex),
        { intervals: [16] },
      )
      .toBeLessThanOrEqual(0.25);
    await pager.evaluate(
      (node, input) => {
        const frame = node as HTMLElement;
        const panels = Array.from(
          frame.querySelectorAll<HTMLElement>("[data-home-feed-panel]"),
        );
        const source = panels[input.sourceIndex];
        const target = panels[input.targetIndex];
        if (source === undefined || target === undefined) {
          throw new Error("Missing Home feed panel");
        }
        // Business selection precedes visual settling. Request the adjacent
        // direction from that selection; a moving target can still be on the
        // other side of the viewport during a rapid reversal.
        const distance =
          (input.targetIndex - input.sourceIndex) * frame.clientWidth;
        for (const [type, progress] of [
          ["touchstart", 0],
          ["touchmove", 0.25],
          ["touchmove", 0.6],
          ["touchmove", 1],
        ] as const) {
          const point = {
            identifier: 1,
            target: frame,
            clientX: frame.clientWidth * 0.75 - distance * progress,
            clientY: 300,
          };
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, {
            touches: { value: [point] },
            changedTouches: { value: [point] },
          });
          frame.dispatchEvent(event);
        }
        const end = new Event("touchend", { bubbles: true, cancelable: true });
        Object.defineProperty(end, "touches", { value: [] });
        frame.dispatchEvent(end);
      },
      { sourceIndex: currentIndex, targetIndex },
    );
    await expect(home).toHaveAttribute("data-active-home-feed", targetFeed);
    currentIndex = targetIndex;
  }

  const activeBeforeShortDrag = feeds[currentIndex];
  if (activeBeforeShortDrag === undefined)
    throw new Error("Missing active feed");
  await expectSettledFeed(activeBeforeShortDrag);
  await pager.evaluate(async (node, sourceIndex) => {
    const frame = node as HTMLElement;
    const panels = Array.from(
      frame.querySelectorAll<HTMLElement>("[data-home-feed-panel]"),
    );
    const source = panels[sourceIndex];
    const neighbor = panels[sourceIndex === 0 ? 1 : sourceIndex - 1];
    if (source === undefined || neighbor === undefined) {
      throw new Error("Missing short-drag panel");
    }
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.2],
      ["touchmove", 0],
    ] as const) {
      const point = {
        identifier: 1,
        target: frame,
        clientX:
          frame.clientWidth * 0.75 -
          (neighbor.offsetLeft - source.offsetLeft) * progress,
        clientY: 300,
      };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: [point] },
        changedTouches: { value: [point] },
      });
      frame.dispatchEvent(event);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    const end = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(end, "touches", { value: [] });
    frame.dispatchEvent(end);
  }, currentIndex);
  await expect(home).toHaveAttribute(
    "data-active-home-feed",
    activeBeforeShortDrag,
  );

  await expectSettledFeed(activeBeforeShortDrag);

  const evidence = await pager.evaluate((node) => {
    const frame = node as HTMLElement & {
      __r03NativeSettleEvidence?: {
        activeFeedChanges: string[];
        programmaticScrolls: number[];
      };
    };
    return frame.__r03NativeSettleEvidence;
  });
  expect(evidence?.activeFeedChanges).toHaveLength(30);
  expect(evidence?.programmaticScrolls).toEqual([]);

  // Separately retain rapid interruption coverage: start the reverse gesture
  // from the moving track, before the first release has visually settled.
  const interruption = await pager.evaluate(async (node) => {
    const frame = node as HTMLElement;
    const surface = frame.closest<HTMLElement>("[data-home-surface]")!;
    const target = frame.querySelector<HTMLElement>(
      '[data-home-feed-panel="nearby"]',
    )!;
    const track = target.parentElement!;
    const touch = (type: string, x: number) => {
      const point = { identifier: 1, target: frame, clientX: x, clientY: 300 };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [point] },
        changedTouches: { value: [point] },
      });
      frame.dispatchEvent(event);
    };
    const drag = async (from: number, to: number) => {
      for (let step = 1; step <= 8; step += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        touch(
          "touchmove",
          frame.clientWidth * (from + ((to - from) * step) / 8),
        );
      }
      touch("touchend", frame.clientWidth * to);
    };
    touch("touchstart", frame.clientWidth * 0.8);
    await drag(0.8, 0.2);
    const firstCommit = surface.dataset.activeHomeFeed;
    const remaining = Math.abs(
      target.getBoundingClientRect().left - frame.getBoundingClientRect().left,
    );
    const beforeReverse = track.getBoundingClientRect().left;
    touch("touchstart", frame.clientWidth * 0.2);
    const afterReverseStart = track.getBoundingClientRect().left;
    await drag(0.2, 0.8);
    return { firstCommit, remaining, beforeReverse, afterReverseStart };
  });
  expect(interruption.firstCommit).toBe("nearby");
  expect(interruption.remaining).toBeGreaterThan(2);
  expect(interruption.afterReverseStart).toBe(interruption.beforeReverse);
  await expect(home).toHaveAttribute("data-active-home-feed", "discover");
  await expectSettledFeed("discover");
  const interruptedEvidence = await pager.evaluate(
    (node) =>
      (
        node as HTMLElement & {
          __r03NativeSettleEvidence?: {
            activeFeedChanges: string[];
            programmaticScrolls: number[];
          };
        }
      ).__r03NativeSettleEvidence,
  );
  expect(interruptedEvidence?.activeFeedChanges).toEqual([
    ...evidence!.activeFeedChanges,
    "nearby",
    "discover",
  ]);
  expect(interruptedEvidence?.programmaticScrolls).toEqual([]);
});

test("Home PC pager accepts only explicit horizontal wheel input", async ({
  page,
}, testInfo) => {
  test.skip(
    expectedInitialAutoPlatform(testInfo.project.name) !== "pc",
    "The explicit wheel path belongs to PC presentation.",
  );
  const { surface } = await openDevelopmentSurface(page);
  const home = activeHomeSurface(surface);
  const pager = home.locator("[data-home-feed-pager]");

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
  await expect(productShell(surface)).toHaveAttribute(
    "data-active-destination",
    "home",
  );
});

test("Home PC feeds keep document scroll restoration without nested scrollers", async ({
  page,
}, testInfo) => {
  test.skip(
    expectedInitialAutoPlatform(testInfo.project.name) !== "pc",
    "The document-scroll regression belongs to PC presentation.",
  );
  const { surface } = await openDevelopmentSurface(page);
  const shell = productShell(surface);
  const home = activeHomeSurface(surface);
  for (const feed of [
    "discover",
    "nearby",
    "inscriptions",
    "calligraphy",
  ] as const) {
    const panel = home.locator(`[data-home-feed-panel="${feed}"]`);
    await expect(panel).toHaveCSS("overflow-y", "visible");
    await expect(panel).not.toHaveAttribute(
      "data-home-feed-scroll-surface",
      "",
    );
  }

  await waitForStableHomePanelEvidence(home, "discover");
  const discoverTop = await writePrimaryScroll(shell, "home", 260);
  expect(discoverTop).toBeGreaterThan(0);
  await activateHomeFeed(home, "附近");
  // A first zero sample can precede the queued feed restoration. Await the
  // existing frame/geometry readiness before writing the next saved offset.
  await waitForStableHomePanelEvidence(home, "nearby");
  await expect.poll(() => readPrimaryScroll(shell, "home")).toBe(0);
  const nearbyTop = await writePrimaryScroll(shell, "home", 190);
  expect(nearbyTop).toBeGreaterThan(0);
  await activateHomeFeed(home, "发现");
  await expect.poll(() => readPrimaryScroll(shell, "home")).toBe(discoverTop);
  await activateHomeFeed(home, "附近");
  await expect.poll(() => readPrimaryScroll(shell, "home")).toBe(nearbyTop);
});

test("Home preserves independent Discover, Nearby, and Calligraphy scroll positions", async ({
  page,
}, testInfo) => {
  test.skip(
    expectedInitialAutoPlatform(testInfo.project.name) === "pc",
    "Independent Home panel scrollers belong to Phone and Tablet.",
  );
  const { surface } = await openDevelopmentSurface(page);
  const shell = productShell(surface);
  const home = activeHomeSurface(surface);
  const outerHome = shell.locator('[data-primary-destination="home"]');
  const pager = home.locator("[data-home-feed-pager]");
  const feeds = ["discover", "nearby", "calligraphy"] as const;
  const desired = { discover: 900, nearby: 350, calligraphy: 900 } as const;

  for (const feed of feeds) {
    const panel = home.locator(`[data-home-feed-panel="${feed}"]`);
    await expect(panel).toHaveCSS("overflow-y", "auto");
    await panel.evaluate((node, identity) => {
      (node as HTMLElement).dataset.testScrollIdentity = identity;
    }, `stable-${feed}`);
  }
  await expect(outerHome).toHaveCSS("overflow-y", "hidden");
  expect(
    await outerHome.evaluate((node) => (node as HTMLElement).scrollTop),
  ).toBe(0);

  const saved = {
    discover: await writeHomePanelScroll(home, "discover", desired.discover),
    nearby: await writeHomePanelScroll(home, "nearby", desired.nearby),
    calligraphy: await writeHomePanelScroll(
      home,
      "calligraphy",
      desired.calligraphy,
    ),
  };
  expect(saved.discover).toBeGreaterThan(0);
  expect(saved.nearby).toBeGreaterThan(0);
  expect(saved.calligraphy).toBeGreaterThan(0);
  await touchSettleHomeFeed(home, "discover");
  expect(await pager.evaluate((node) => (node as HTMLElement).scrollLeft)).toBe(
    0,
  );
  await expect(home).toHaveAttribute("data-active-home-feed", "discover");
  const baseline = {
    discover: await settleHomeFeedAndReadStableEvidence(home, "discover"),
    nearby: await settleHomeFeedAndReadStableEvidence(home, "nearby"),
    calligraphy: await settleHomeFeedAndReadStableEvidence(home, "calligraphy"),
  };
  await touchSettleHomeFeed(home, "discover");

  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.5],
    ] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: [
          {
            identifier: 1,
            target: frame,
            clientX: frame.clientWidth * (0.75 - progress),
            clientY: 300,
          },
        ],
      });
      frame.dispatchEvent(event);
    }
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "discover");
  expect((await readHomePanelEvidence(home, "nearby")).scrollTop).toBe(
    saved.nearby,
  );
  expect(
    await outerHome.evaluate((node) => (node as HTMLElement).scrollTop),
  ).toBe(0);
  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    for (const type of ["touchmove", "touchend"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value:
          type === "touchend"
            ? []
            : [
                {
                  identifier: 1,
                  target: frame,
                  clientX: -frame.clientWidth * 0.25,
                  clientY: 300,
                },
              ],
      });
      frame.dispatchEvent(event);
    }
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");

  for (const feed of [
    "calligraphy",
    "nearby",
    "discover",
    "calligraphy",
  ] as const) {
    await touchSettleHomeFeed(home, feed);
    await expect
      .poll(() =>
        readHomePanelEvidence(home, feed).then((state) => state.scrollTop),
      )
      .toBe(saved[feed]);
  }

  const beforeRebound = {
    discover: (await readHomePanelEvidence(home, "discover")).scrollTop,
    nearby: (await readHomePanelEvidence(home, "nearby")).scrollTop,
    calligraphy: (await readHomePanelEvidence(home, "calligraphy")).scrollTop,
  };
  await pager.evaluate((node) => {
    const frame = node as HTMLElement;
    for (const [type, progress] of [
      ["touchstart", 0],
      ["touchmove", 0.15],
      ["touchmove", 0],
      ["touchend", 0],
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
                  clientX: frame.clientWidth * (0.25 + progress),
                  clientY: 300,
                },
              ],
      });
      frame.dispatchEvent(event);
    }
  });
  await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
  expect({
    discover: (await readHomePanelEvidence(home, "discover")).scrollTop,
    nearby: (await readHomePanelEvidence(home, "nearby")).scrollTop,
    calligraphy: (await readHomePanelEvidence(home, "calligraphy")).scrollTop,
  }).toEqual(beforeRebound);

  const { settings, userPage } =
    await openSettingsThroughAvailableEntry(surface);
  await closeSettingsAndUserPage(settings, userPage);
  await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
  expect((await readHomePanelEvidence(home, "calligraphy")).scrollTop).toBe(
    saved.calligraphy,
  );

  const navigation = surface.getByRole("navigation", { name: "主要内容" });
  await ensurePrimaryNavigationExpanded(navigation);
  await navigation.getByRole("button", { name: "讨论", exact: true }).click();
  await expectActiveDestination(surface, "discussion");
  await navigation.getByRole("button", { name: "首页", exact: true }).click();
  await expectActiveDestination(surface, "home");
  await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
  await expect
    .poll(() =>
      readHomePanelEvidence(home, "calligraphy").then(
        (state) => state.scrollTop,
      ),
    )
    .toBe(saved.calligraphy);

  const finalEvidence = {
    discover: await settleHomeFeedAndReadStableEvidence(home, "discover"),
    nearby: await settleHomeFeedAndReadStableEvidence(home, "nearby"),
    calligraphy: await settleHomeFeedAndReadStableEvidence(home, "calligraphy"),
  };
  for (const feed of feeds) {
    const masonryHeightDelta = Math.abs(
      (finalEvidence[feed].masonryHeight ?? 0) -
        (baseline[feed].masonryHeight ?? 0),
    );
    expect(
      Math.abs(finalEvidence[feed].scrollTop - saved[feed]),
    ).toBeLessThanOrEqual(2);
    expect(finalEvidence[feed].testIdentity).toBe(`stable-${feed}`);
    expect(finalEvidence[feed].layoutReady).toBe("true");
    expect(finalEvidence[feed].masonryColumns).toBe(
      baseline[feed].masonryColumns,
    );
    expect(
      Math.abs(
        (finalEvidence[feed].masonryWidth ?? 0) -
          (baseline[feed].masonryWidth ?? 0),
      ),
    ).toBeLessThanOrEqual(2);
    expect(masonryHeightDelta).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        (finalEvidence[feed].anchorX ?? 0) - (baseline[feed].anchorX ?? 0),
      ),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        (finalEvidence[feed].anchorY ?? 0) - (baseline[feed].anchorY ?? 0),
      ),
    ).toBeLessThanOrEqual(2);
  }
  expect(
    await outerHome.evaluate((node) => (node as HTMLElement).scrollTop),
  ).toBe(0);
});

test("Topic Detail is a Product overlay with stable navigation, history, and focus restoration", async ({
  page,
}) => {
  const { surface } = await openDevelopmentSurface(page);
  await homeScenarioSelector(surface).selectOption("topics-editorial");
  const discussion = await openDiscussionTopics(surface);
  const navigationNode = surface.locator("[data-primary-navigation]");
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  const opener = discussion.locator("[data-topic-card]").first();
  await navigationNode.evaluate((node) => {
    (node as HTMLElement).dataset.r03Identity = "stable";
  });

  await opener.evaluate((button) => (button as HTMLButtonElement).click());
  const detail = productShell(surface).getByRole("dialog", {
    name: /专题：/,
  });
  await expect(detail).toBeVisible();
  await expect(
    productShell(surface).locator("[data-product-primary-layer]"),
  ).toHaveAttribute("inert", "");
  await expect(navigationNode).toHaveAttribute("data-r03-identity", "stable");
  await expect(navigationNode).toBeHidden();
  await expect(detail.getByRole("button", { name: "返回专题" })).toBeFocused();
  await expect(page).toHaveURL(/#topic-/u);

  await detail.getByRole("button", { name: "返回专题" }).click();
  await expect(detail).toHaveCount(0);
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(opener).toBeFocused();
  await expect(navigationNode).toHaveAttribute("data-r03-identity", "stable");

  await page.goForward();
  await expect(
    productShell(surface).getByRole("dialog", { name: /专题：/ }),
  ).toBeVisible();
});

test("Topic Detail reload and Back preserve the recorded Topics source scroll", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-webkit",
    "The reload-to-Back scroll regression runs once in iPhone WebKit.",
  );
  const response = await page.goto("/dev/t02p/qa?scenario=topics-editorial");
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  const shell = productShell(surface);
  const discussion = await openDiscussionTopics(surface);
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(
    discussion.locator("#discussion-panel-topics [data-home-masonry]"),
  ).toHaveAttribute("data-layout-ready", "true");
  const sourceTop = await writePrimaryScroll(shell, "discussion", 180);
  expect(sourceTop).toBeGreaterThan(0);

  await discussion
    .locator("[data-topic-card]")
    .first()
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(shell.getByRole("dialog", { name: /专题：/ })).toBeVisible();
  await page.reload();
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  await expect(shell.getByRole("dialog", { name: /专题：/ })).toBeVisible();
  const restoredOpener = activeDiscussionSurface(surface)
    .locator("[data-topic-card]")
    .first();
  expect(await page.evaluate(() => window.history.state?.sourceScrollTop)).toBe(
    sourceTop,
  );

  await page.goBack();
  await expect(shell.getByRole("dialog", { name: /专题：/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.history.state?.scrollTop)).toBe(
    sourceTop,
  );
  await expect
    .poll(() => readPrimaryScroll(shell, "discussion"))
    .toBe(sourceTop);
  await expect(restoredOpener).toBeFocused();
});

test("Topic Back preserves Topics and Product Shell identity in Clean Preview", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-webkit",
    "The Clean Preview history-identity regression runs once in iPhone WebKit.",
  );
  const { surface } = await openCleanProductSurface(page);
  const discussion = await openDiscussionTopics(surface);
  const navigation = surface.locator("[data-primary-navigation]");
  await navigation.evaluate((node) => {
    (node as HTMLElement).dataset.r03TopicIdentity = "stable";
  });
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await discussion.locator("[data-topic-card]").first().click();
  const shell = productShell(surface);
  await expect(shell.getByRole("dialog", { name: /专题：/ })).toBeVisible();

  await page.goBack();
  await expect(shell.getByRole("dialog", { name: /专题：/ })).toHaveCount(0);
  await expect(navigation).toHaveAttribute("data-r03-topic-identity", "stable");
  await expect(activeDiscussionSurface(surface)).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await expect(page).toHaveURL(/\?acceptance=r01-clean$/u);
});

test("Catalog Collection Topic resolves Catalog summaries without a fake Detail action", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The collection content audit runs once in Desktop Chromium.",
  );
  const response = await page.goto(
    "/dev/t02p/qa?scenario=topics-catalog-collection",
  );
  expect(response?.status()).toBe(200);
  const surface = page.locator("[data-t02p-qa-harness]");
  await expect(surface.locator("[data-product-boot]")).toHaveCount(0);
  const discussion = await openDiscussionTopics(surface);
  await expect(discussion).toHaveAttribute(
    "data-active-discussion-feed",
    "topics",
  );
  await discussion
    .locator("[data-topic-card]")
    .evaluate((button) => (button as HTMLButtonElement).click());
  const detail = productShell(surface).getByRole("dialog", { name: /专题：/ });
  await expect(detail.locator("[data-topic-collection]")).toBeVisible();
  await expect(detail.locator("[data-catalog-card]")).toHaveCount(6);
  await expect(detail.locator("[data-open-catalog]")).toHaveCount(0);
});

test("Visual Catalog covers valid, absent, and failed media with long-scroll navigation clearance", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The full deterministic media-state audit runs once in Desktop Chromium.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  const home = activeHomeSurface(surface);
  const cards = home.locator(
    '[data-home-feed-panel="discover"] [data-catalog-card]',
  );
  await expect(catalogScenarioSelector(surface)).toHaveValue("visual");
  await expect(cards).toHaveCount(24);

  for (let index = 0; index < 24; index += 1) {
    await cards.nth(index).scrollIntoViewIfNeeded();
  }

  await expect(
    home.locator(
      '[data-home-feed-panel="discover"] [data-catalog-media-state="failed"]',
    ),
  ).toHaveCount(1);
  await expect(
    home.locator(
      '[data-home-feed-panel="discover"] [data-catalog-media-state="missing"]',
    ),
  ).toHaveCount(6);
  await expect(
    home.locator(
      '[data-home-feed-panel="discover"] [data-catalog-media-state="valid"]',
    ),
  ).toHaveCount(17);
  await expect(
    home
      .locator('[data-home-feed-panel="discover"]')
      .getByText("图像无法加载", { exact: true }),
  ).toHaveCount(1);
  await expect(
    home
      .locator('[data-home-feed-panel="discover"]')
      .getByText("暂无公开图像", { exact: true }),
  ).toHaveCount(6);

  const validImages = home.locator(
    '[data-home-feed-panel="discover"] [data-catalog-media-state="valid"] img',
  );
  await expect(validImages).toHaveCount(17);
  expect(
    await validImages.evaluateAll((images) =>
      images.every((image) => {
        const source = new URL((image as HTMLImageElement).currentSrc);
        return (
          source.origin === window.location.origin &&
          source.pathname.startsWith("/docs/design-system/assets/demo/") &&
          (image as HTMLImageElement).complete &&
          (image as HTMLImageElement).naturalWidth > 0
        );
      }),
    ),
  ).toBe(true);

  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const lastCardBox = await cards.last().boundingBox();
  const navigationBox = await navigation.boundingBox();
  if (lastCardBox === null || navigationBox === null) {
    throw new Error("Expected Catalog card and navigation geometry");
  }
  expect(lastCardBox.y + lastCardBox.height).toBeLessThanOrEqual(
    navigationBox.y + 2,
  );
});

test("Catalog scenario selector maps every state without changing destination", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The complete scenario matrix runs once in Desktop Chromium.",
  );

  const { surface } = await openDevelopmentSurface(page);
  const selector = catalogScenarioSelector(surface);

  await selector.selectOption("small-populated");
  await activateHomeFeed(activeHomeSurface(surface), "碑刻");
  await expectActiveHomeFeed(surface, "inscriptions");
  const smallPopulatedImage = activeCatalogPresentation(surface).locator(
    '[data-catalog-media-state="valid"] img',
  );
  await expect(smallPopulatedImage).toHaveCount(1);
  await expect
    .poll(() =>
      smallPopulatedImage.evaluate(
        (image) =>
          (image as HTMLImageElement).complete &&
          (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  const smallPopulatedImageUrl = new URL(
    await smallPopulatedImage.evaluate(
      (image) => (image as HTMLImageElement).currentSrc,
    ),
  );
  expect(smallPopulatedImageUrl.origin).toBe(new URL(page.url()).origin);
  expect(smallPopulatedImageUrl.pathname).toBe(
    "/docs/design-system/assets/demo/rubbing-fragment.svg",
  );

  await activateHomeFeed(activeHomeSurface(surface), "书帖");
  await expectActiveHomeFeed(surface, "calligraphy");

  await expect(surface).toHaveAttribute(
    "data-catalog-scenario",
    "small-populated",
  );
  await expectActiveHomeFeed(surface, "calligraphy");
  await expect(
    activeCatalogPresentation(surface).locator("[data-catalog-card]"),
  ).toHaveCount(1);

  for (const [scenario, state, text] of [
    ["empty", "empty", "暂无公开书帖"],
    ["unavailable", "unavailable", "档案服务暂时不可用"],
    ["unexpected-error", "unexpected-error", "无法加载公开档案"],
  ] as const) {
    await selector.selectOption(scenario);
    await expect(surface).toHaveAttribute("data-catalog-scenario", scenario);
    await expectActiveHomeFeed(surface, "calligraphy");
    await expect(
      activeCatalogPresentation(surface).locator(
        "[data-calligraphy-category-state]",
      ),
    ).toHaveAttribute("data-calligraphy-category-state", state);
    await expect(
      activeCatalogPresentation(surface).getByText(text),
    ).toBeVisible();
  }
});

test("Feed layout remains bounded to phone/tablet while PC stays responsive", async ({
  page,
}, testInfo) => {
  const { surface } = await openDevelopmentSurface(page);
  const masonry = activeHomeMasonry(surface);
  await expect(masonry).toHaveAttribute("data-layout-ready", "true");
  await expect(productShell(surface)).toHaveAttribute(
    "data-feed-layout",
    "double",
  );

  if (expectedInitialAutoPlatform(testInfo.project.name) === "pc") {
    const { settings, userPage } =
      await openSettingsThroughAvailableEntry(surface);
    await expect(settings.locator("[data-feed-layout-toggle]")).toHaveCount(0);
    await closeSettingsAndUserPage(settings, userPage);
    const columnCount = Number(
      await masonry.getAttribute("data-masonry-columns"),
    );
    expect(columnCount).toBeGreaterThanOrEqual(3);
    expect(columnCount).toBeLessThanOrEqual(8);
    await expect(
      masonry.locator('[data-home-masonry-span="full"]'),
    ).toHaveCount(0);
    return;
  }

  await expect(masonry).toHaveAttribute("data-masonry-columns", "2");
  await expectActiveDestination(surface, "home");
  await expectAlignedHomeFeatures(masonry);

  await setFeedLayoutThroughSettings(surface, "single");
  await expect(masonry).toHaveAttribute("data-masonry-columns", "1");
  await expect(masonry.locator('[data-home-masonry-span="full"]')).toHaveCount(
    0,
  );
  await expectActiveDestination(surface, "home");
  const [masonryBox, firstItemBox] = await Promise.all([
    requireBoundingBox(masonry),
    requireBoundingBox(masonry.locator("[data-home-masonry-item]").first()),
  ]);
  expect(Math.abs(masonryBox.width - firstItemBox.width)).toBeLessThan(2);
});

test("Tablet Double gives Home aligned features and Calligraphy cards stable geometry", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "tablet-webkit",
    "The Tablet feed composition audit runs only in Tablet WebKit.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  await page.setViewportSize({ height: 1194, width: 834 });
  await expect(platformSelector(surface)).toHaveValue("auto");
  await expectPresentationPlatform(surface, "tablet");
  await expect(productShell(surface)).toHaveAttribute(
    "data-feed-layout",
    "double",
  );

  const home = activeHomeSurface(surface);
  const homeFeed = activeHomeMasonry(surface);
  await expect(homeFeed).toHaveAttribute("data-layout-ready", "true");
  await expect(homeFeed).toHaveAttribute("data-masonry-columns", "2");
  const homeUltraWideCard = homeFeed.locator(
    '[data-catalog-id="qa-visual-inscription-04"]',
  );
  const homeUltraWide = masonryItemContaining(
    homeFeed,
    '[data-catalog-id="qa-visual-inscription-04"]',
  );
  await expectAlignedHomeFeatures(homeFeed);
  const beforeFailure = await requireBoundingBox(homeUltraWide);
  const image = homeUltraWideCard.locator("img");
  await expect(image).toHaveCSS("object-fit", "cover");
  const imageBox = await requireBoundingBox(image);
  expect(imageBox.width / imageBox.height).toBeLessThanOrEqual(1.8);

  await homeUltraWideCard.locator("img").dispatchEvent("error");
  expect(
    Math.abs(
      (await requireBoundingBox(homeUltraWide)).width - beforeFailure.width,
    ),
  ).toBeLessThanOrEqual(2);
  await expectAlignedHomeFeatures(homeFeed);
  await expect(
    homeUltraWideCard.locator('[data-catalog-media-state="failed"]'),
  ).toBeVisible();
  await expectCatalogCardsNotToOverlap(homeFeed);
  await expectNoHorizontalOverflow(page);
  await expectFeedToClearNavigation({ feed: homeFeed, navigation, page });

  await activateHomeFeed(activeHomeSurface(surface), "书帖");
  await expectActiveHomeFeed(surface, "calligraphy");
  await page.setViewportSize({ height: 834, width: 1194 });
  await expect(platformSelector(surface)).toHaveValue("auto");
  await expectPresentationPlatform(surface, "tablet");
  await expectActiveHomeFeed(surface, "calligraphy");

  const calligraphy = activeCatalogPresentation(surface);
  const calligraphyFeed = calligraphy.locator("[data-home-masonry]");
  await expect(calligraphyFeed).toHaveAttribute("data-layout-ready", "true");
  await expect(
    calligraphy.locator('[data-catalog-feed-span="full"]'),
  ).toHaveCount(1);
  await expectFeedCardGeometry({
    columnCount: 2,
    feed: calligraphyFeed,
    fullCard: masonryItemContaining(
      calligraphyFeed,
      '[data-catalog-id="qa-visual-calligraphy-05"]',
    ),
    fullSpan:
      (await masonryItemContaining(
        calligraphyFeed,
        '[data-catalog-id="qa-visual-calligraphy-05"]',
      ).getAttribute("data-home-masonry-span")) === "full",
    normalCard: masonryItemContaining(
      calligraphyFeed,
      '[data-catalog-id="qa-visual-calligraphy-01"]',
    ),
  });
  const calligraphyPanorama = calligraphy.locator(
    '[data-catalog-id="qa-visual-calligraphy-05"] img',
  );
  await expect(calligraphyPanorama).toHaveCSS("object-fit", "cover");
  const calligraphyImageBox = await requireBoundingBox(calligraphyPanorama);
  expect(
    calligraphyImageBox.width / calligraphyImageBox.height,
  ).toBeLessThanOrEqual(1.5 + 0.01);
  await expectCatalogCardsNotToOverlap(calligraphyFeed);
  await expectNoHorizontalOverflow(page);

  await activateHomeFeed(home, "发现");
  await expectActiveDestination(surface, "home");
  await expect(activeHomeMasonry(surface)).toHaveAttribute(
    "data-masonry-columns",
    "2",
  );
  await waitForStableHomePanelEvidence(home, "discover");
  await expectAlignedHomeFeatures(activeHomeMasonry(surface));

  await setFeedLayoutThroughSettings(surface, "single");
  await expect(activeHomeMasonry(surface)).toHaveAttribute(
    "data-masonry-columns",
    "1",
  );
  await expect(
    activeHomeMasonry(surface).locator('[data-home-masonry-span="full"]'),
  ).toHaveCount(0);

  await activateHomeFeed(activeHomeSurface(surface), "碑刻");
  await expectActiveHomeFeed(surface, "inscriptions");
  const inscriptions = activeCatalogPresentation(surface);
  const inscriptionList = inscriptions.locator("[data-catalog-item-count]");
  await expect(inscriptions.locator("[data-catalog-feed-span]")).toHaveCount(0);
  const [inscriptionListBox, inscriptionCardBox] = await Promise.all([
    requireBoundingBox(inscriptionList),
    requireBoundingBox(inscriptions.locator("[data-catalog-card]").first()),
  ]);
  expect(
    Math.abs(inscriptionCardBox.width - inscriptionListBox.width),
  ).toBeLessThan(2);
  await expectNoHorizontalOverflow(page);
});

test("Auto mode applies desktop viewport boundaries without resetting the active destination", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Desktop policy boundaries run only in the desktop browser context.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  await confirmMouseNavigationReady(surface, navigation);
  await navigation.getByRole("button", { exact: true, name: "讨论" }).click();
  await expectActiveDestination(surface, "discussion");
  await expect(platformSelector(surface)).toHaveValue("auto");

  for (const [width, platform] of [
    [767, "phone"],
    [768, "tablet"],
    [895, "tablet"],
    [896, "pc"],
  ] as const satisfies readonly (readonly [number, AcceptancePlatform])[]) {
    await page.setViewportSize({ height: 900, width });
    await expectPresentationPlatform(surface, platform);
    await expectActiveDestination(surface, "discussion");
  }
});

test("Auto mode keeps an iPhone-like runtime on phone across viewport changes", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-webkit",
    "Phone runtime policy runs only in the Mobile WebKit context.",
  );

  const { surface } = await openDevelopmentSurface(page);
  await expect(platformSelector(surface)).toHaveValue("auto");
  await expectPresentationPlatform(surface, "phone");
  const home = activeHomeSurface(surface);
  const discoverTop = await writeHomePanelScroll(home, "discover", 600);
  const nearbyTop = await writeHomePanelScroll(home, "nearby", 300);
  await touchSettleHomeFeed(home, "nearby");

  await page.setViewportSize({ height: 500, width: 1200 });
  await expectPresentationPlatform(surface, "phone");
  expect((await readHomePanelEvidence(home, "discover")).scrollTop).toBe(
    discoverTop,
  );
  expect((await readHomePanelEvidence(home, "nearby")).scrollTop).toBe(
    nearbyTop,
  );
  await page.setViewportSize({ height: 700, width: 320 });
  await expectPresentationPlatform(surface, "phone");
  await expect(home).toHaveAttribute("data-active-home-feed", "nearby");
  expect((await readHomePanelEvidence(home, "discover")).scrollTop).toBe(
    discoverTop,
  );
  expect((await readHomePanelEvidence(home, "nearby")).scrollTop).toBe(
    nearbyTop,
  );
});

test("Auto mode applies iPad-like viewport caps in both directions", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "tablet-webkit",
    "Tablet runtime policy runs only in the Tablet WebKit context.",
  );

  const { surface } = await openDevelopmentSurface(page);
  await expect(platformSelector(surface)).toHaveValue("auto");
  await expectPresentationPlatform(surface, "tablet");
  const home = activeHomeSurface(surface);
  const discoverTop = await writeHomePanelScroll(home, "discover", 700);
  const calligraphyTop = await writeHomePanelScroll(home, "calligraphy", 500);
  await touchSettleHomeFeed(home, "calligraphy");

  await page.setViewportSize({ height: 900, width: 600 });
  await expectPresentationPlatform(surface, "phone");
  expect((await readHomePanelEvidence(home, "discover")).scrollTop).toBe(
    discoverTop,
  );
  expect((await readHomePanelEvidence(home, "calligraphy")).scrollTop).toBe(
    calligraphyTop,
  );
  await page.setViewportSize({ height: 768, width: 1024 });
  await expectPresentationPlatform(surface, "tablet");
  await expect(home).toHaveAttribute("data-active-home-feed", "calligraphy");
  expect((await readHomePanelEvidence(home, "discover")).scrollTop).toBe(
    discoverTop,
  );
  expect((await readHomePanelEvidence(home, "calligraphy")).scrollTop).toBe(
    calligraphyTop,
  );
});

test("Auto mode synchronizes from current runtime values on orientationchange", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The isolated orientation event check runs once in Desktop Chromium.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  await confirmMouseNavigationReady(surface, navigation);
  await navigation.getByRole("button", { exact: true, name: "用户" }).click();
  await expectActiveDestination(surface, "user");

  await page.evaluate(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    window.dispatchEvent(new Event("orientationchange"));
  });

  await expectPresentationPlatform(surface, "tablet");
  await expectActiveDestination(surface, "user");
});

test("QA overrides survive runtime changes and returning Auto uses the current runtime", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Override and reload coordination run once in Desktop Chromium.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  const qaPlatformSelector = platformSelector(surface);
  await confirmMouseNavigationReady(surface, navigation);
  await navigation.getByRole("button", { exact: true, name: "讨论" }).click();
  await expectActiveDestination(surface, "discussion");

  for (const [mode, width] of [
    ["phone", 1000],
    ["tablet", 500],
    ["pc", 800],
  ] as const satisfies readonly (readonly [AcceptancePlatform, number])[]) {
    await qaPlatformSelector.selectOption(mode);
    await page.setViewportSize({ height: 900, width });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("orientationchange"));
    });
    await expectPresentationPlatform(surface, mode);
    await expectActiveDestination(surface, "discussion");
  }

  await qaPlatformSelector.selectOption("auto");
  await expectPresentationPlatform(surface, "tablet");
  await expectActiveDestination(surface, "discussion");

  await qaPlatformSelector.selectOption("phone");
  await page.reload();
  const reloadedSurface = page.locator("[data-t02p-qa-harness]");
  await expect(reloadedSurface).toBeVisible();
  await expect(platformSelector(reloadedSurface)).toHaveValue("auto");
  await expectPresentationPlatform(reloadedSurface, "tablet");
});

test("Reduced motion preserves tap and release-only primary commits", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Reduced-motion Product semantics run once in Desktop Chromium.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  const { navigation, surface } = await openCleanProductSurface(page);
  const discussionButton = navigation.getByRole("button", {
    exact: true,
    name: "讨论",
  });
  const userButton = navigation.getByRole("button", {
    exact: true,
    name: "用户",
  });

  await discussionButton.click();
  await expectActiveDestination(surface, "discussion");

  const discussionCenter = await locatorCenter(discussionButton);
  const userCenter = await locatorCenter(userButton);
  await page.mouse.move(discussionCenter.x, discussionCenter.y);
  await page.mouse.down();
  await page.mouse.move(userCenter.x, userCenter.y, { steps: 5 });
  await expectActiveDestination(surface, "discussion");
  await page.mouse.up();
  await expectActiveDestination(surface, "user");
});

test("Touchscreen tap commits each primary destination on touch WebKit", async ({
  page,
}, testInfo) => {
  test.skip(
    !["mobile-webkit", "tablet-webkit", "tablet-landscape-webkit"].includes(
      testInfo.project.name,
    ),
    "Touchscreen evidence runs only in configured touch contexts.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);

  for (const destination of ["discussion", "user", "home"] as const) {
    const targetButton = navigation.getByRole("button", {
      exact: true,
      name: destinationAcceptance[destination].label,
    });
    const center = await locatorCenter(targetButton);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("button")
            ?.getAttribute("aria-label") ?? null,
        center,
      ),
    ).toBe(destinationAcceptance[destination].label);
    await page.touchscreen.tap(center.x, center.y);
    await expectActiveDestination(surface, destination);
  }
});

test("Mobile WebKit locator click commits each primary destination", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-webkit",
    "Locator-click evidence is reported separately for Mobile WebKit.",
  );

  const { navigation, surface } = await openCleanProductSurface(page);

  for (const destination of ["discussion", "user", "home"] as const) {
    await navigation
      .getByRole("button", {
        exact: true,
        name: destinationAcceptance[destination].label,
      })
      .click();
    await expectActiveDestination(surface, destination);
  }
});

test("R02 keeps one navigation tree and isolates accepted marks from the glass compositor", async ({
  page,
}) => {
  const navigationAssetResponses: { status: number; url: string }[] = [];
  const navigationAssetFailures: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const guestProbeStatuses: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/community/me") {
      guestProbeStatuses.push(response.status());
    }
    if (
      /\/_next\/static\/media\/(?:home|discussion|user|nav-)/u.test(
        response.url(),
      )
    ) {
      navigationAssetResponses.push({
        status: response.status(),
        url: response.url(),
      });
    }
  });
  page.on("requestfailed", (request) => {
    if (
      /\/_next\/static\/media\/(?:home|discussion|user|nav-)/u.test(
        request.url(),
      )
    ) {
      navigationAssetFailures.push(request.url());
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.location().url.includes("qa-visual-intentionally-missing.svg")
    ) {
      consoleErrors.push(message.text());
    }
  });

  const { navigation, surface } = await openDevelopmentSurface(page);
  await expect(
    navigation.locator("[data-primary-navigation-inline-icon]"),
  ).toHaveCount(3);
  await expect(
    navigation.locator("[data-primary-navigation-text-label]"),
  ).toHaveCount(3);
  await expect(
    navigation.locator("[data-primary-navigation-text-label]"),
  ).toHaveText(["首页", "讨论", "用户"]);
  await expect(
    navigation.locator(
      "[data-primary-navigation-text-label] image, [data-primary-navigation-text-label] img",
    ),
  ).toHaveCount(0);

  const initialRendering = await navigation.evaluate((node) => {
    const navigationElement = node as HTMLElement;
    const icons = Array.from(
      navigationElement.querySelectorAll(
        "[data-primary-navigation-inline-icon]",
      ),
    );
    const labels = Array.from(
      navigationElement.querySelectorAll(
        "[data-primary-navigation-text-label]",
      ),
    );
    const glass = navigationElement.querySelector(
      "[data-primary-navigation-glass]",
    );
    Object.assign(window, {
      __r02NavigationIdentity: { glass, icons, labels, navigationElement },
    });
    return {
      glassBackdrop:
        glass instanceof HTMLElement
          ? getComputedStyle(glass).getPropertyValue(
              "-webkit-backdrop-filter",
            ) ||
            getComputedStyle(glass).backdropFilter ||
            "none"
          : "missing",
      iconMasks: icons.map(
        (icon) =>
          getComputedStyle(icon).webkitMaskImage ||
          getComputedStyle(icon).maskImage ||
          "none",
      ),
      labelFonts: labels.map((label) => getComputedStyle(label).fontFamily),
      editorialFont: (() => {
        const probe = document.createElement("span");
        probe.style.fontFamily = "var(--yoyi-font-editorial)";
        navigationElement.append(probe);
        const value = getComputedStyle(probe).fontFamily;
        probe.remove();
        return value;
      })(),
      labelMasks: labels.map(
        (label) =>
          getComputedStyle(label).webkitMaskImage ||
          getComputedStyle(label).maskImage ||
          "none",
      ),
      navigationBackdrop:
        getComputedStyle(navigationElement).getPropertyValue(
          "-webkit-backdrop-filter",
        ) ||
        getComputedStyle(navigationElement).backdropFilter ||
        "none",
    };
  });
  expect(initialRendering.navigationBackdrop).toBe("none");
  expect(initialRendering.glassBackdrop).not.toBe("none");
  expect(initialRendering.glassBackdrop).not.toBe("missing");
  expect(initialRendering.iconMasks).toEqual(["none", "none", "none"]);
  expect(initialRendering.labelMasks).toEqual(["none", "none", "none"]);
  expect(initialRendering.editorialFont).not.toBe("");
  for (const font of initialRendering.labelFonts)
    expect(font.replaceAll('"', "").replaceAll(" ", "")).toBe(
      initialRendering.editorialFont.replaceAll('"', "").replaceAll(" ", ""),
    );

  for (const destination of ["discussion", "user", "home"] as const) {
    await navigation
      .getByRole("button", {
        exact: true,
        name: destinationAcceptance[destination].label,
      })
      .click();
    await expectActiveDestination(surface, destination);
  }
  const { settings, userPage } =
    await openSettingsThroughAvailableEntry(surface);
  await closeSettingsAndUserPage(settings, userPage);

  const viewport = page.viewportSize();
  if (viewport !== null) {
    await page.setViewportSize({
      height: viewport.width,
      width: viewport.height,
    });
  }
  await expect
    .poll(async () => {
      const [shellPlatform, navigationPlatform] = await Promise.all([
        productShell(surface).getAttribute("data-platform"),
        navigation.getAttribute("data-platform"),
      ]);
      return shellPlatform !== null && shellPlatform === navigationPlatform
        ? shellPlatform
        : null;
    })
    .toMatch(/^(?:phone|tablet|pc)$/u);
  expect(
    await navigation.evaluate((node) => {
      const identity = (
        window as typeof window & {
          __r02NavigationIdentity: {
            glass: Element | null;
            icons: Element[];
            labels: Element[];
            navigationElement: Element;
          };
        }
      ).__r02NavigationIdentity;
      return (
        identity.navigationElement === node &&
        identity.glass ===
          node.querySelector("[data-primary-navigation-glass]") &&
        identity.icons.every(
          (icon, index) =>
            icon ===
            node.querySelectorAll("[data-primary-navigation-inline-icon]")[
              index
            ],
        ) &&
        identity.labels.every(
          (label, index) =>
            label ===
            node.querySelectorAll("[data-primary-navigation-text-label]")[
              index
            ],
        )
      );
    }),
  ).toBe(true);

  expect(navigationAssetFailures).toEqual([]);
  await expect(
    navigation.locator(
      "[data-primary-navigation-inline-icon] image, [data-primary-navigation-inline-icon] use",
    ),
  ).toHaveCount(0);
  expect(
    new Set(
      navigationAssetResponses
        .filter(({ url }) =>
          /\/nav-(?:home|inscriptions|calligraphy|discussion|user)\.[^.]+\.png/u.test(
            url,
          ),
        )
        .map(({ url }) => new URL(url).pathname),
    ).size,
  ).toBe(0);
  expect(navigationAssetResponses.every(({ status }) => status < 400)).toBe(
    true,
  );
  // Both mounted author providers probe identity as guests. The browser logs
  // their required 401 responses; retain every error and reject any other one.
  expect(guestProbeStatuses).toEqual([401, 401]);
  expect(consoleErrors).toEqual([
    "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
  ]);
  expect(pageErrors).toEqual([]);
});

test("Mobile and Tablet navigation minimize with hysteresis, idle restore, and an expand-only tap", async ({
  page,
}, testInfo) => {
  test.skip(
    !["mobile-webkit", "tablet-webkit", "tablet-landscape-webkit"].includes(
      testInfo.project.name,
    ),
    "The canonical minimize behavior applies to Phone and Tablet navigation.",
  );

  const { navigation, surface } = await openDevelopmentSurface(page);
  const shell = productShell(surface);
  const expandedBox = await requireBoundingBox(navigation);
  const searchAction = surface.locator("[data-search-trigger]");
  const activeSection = surface.locator('[data-primary-destination="home"]');
  const scrollTo = async (top: number) =>
    activeSection.evaluate((node, nextTop) => {
      const section = node as HTMLElement;
      const scrollElement = section.querySelector<HTMLElement>(
        '[data-home-feed-panel][aria-hidden="false"]',
      );
      if (scrollElement === null) throw new Error("Missing active Home panel");
      scrollElement.scrollTop = nextTop;
      scrollElement.dispatchEvent(new Event("scroll"));
      return scrollElement.scrollTop;
    }, top);

  expect(await scrollTo(20)).toBeGreaterThanOrEqual(12);
  await expect(navigation).toHaveAttribute("data-minimized", "true");
  await expect(shell).toHaveAttribute(
    "data-primary-navigation-minimized",
    "true",
  );

  // The 420 ms collapse transition is slightly longer than the 400 ms idle
  // deadline. Restart that deadline partway through the transition so the
  // fully collapsed geometry has a deterministic observation window.
  await page.waitForTimeout(250);
  await scrollTo(40);
  await expect(navigation).toHaveAttribute("data-minimized", "true");
  await page.waitForTimeout(190);
  const minimizedBox = await requireBoundingBox(navigation);
  expect(Math.abs(minimizedBox.width - 44)).toBeLessThan(4);
  expect(Math.abs(minimizedBox.height - 44)).toBeLessThan(2);
  const minimizedSearchBox = await requireBoundingBox(searchAction);
  expect(Math.abs(minimizedSearchBox.width - 44)).toBeLessThan(2);
  expect(Math.abs(minimizedSearchBox.height - 44)).toBeLessThan(2);
  expect(Math.abs(minimizedSearchBox.y - minimizedBox.y)).toBeLessThan(2);
  await expect(
    navigation.locator("[data-primary-navigation-bubble]"),
  ).toBeHidden();
  expect(
    await navigation
      .locator("[data-primary-navigation-text-label]")
      .evaluateAll((labels) =>
        labels.every((label) => label.getClientRects().length === 0),
      ),
  ).toBe(true);
  await expect(
    navigation.locator("[data-primary-navigation-destination]:visible"),
  ).toHaveCount(1);

  await expect(navigation).toHaveAttribute("data-minimized", "false");
  await expect
    .poll(() =>
      requireBoundingBox(navigation).then((box) =>
        Math.abs(box.width - expandedBox.width),
      ),
    )
    .toBeLessThan(1);

  await scrollTo(60);
  await expect(navigation).toHaveAttribute("data-minimized", "true");
  await scrollTo(100);
  await scrollTo(88);
  await expect(navigation).toHaveAttribute("data-minimized", "true");
  await scrollTo(76);
  await expect(navigation).toHaveAttribute("data-minimized", "false");

  await scrollTo(96);
  await expect(navigation).toHaveAttribute("data-minimized", "true");
  const beforeExpandTap = await page.evaluate(() => ({
    active: document
      .querySelector("[data-product-shell]")
      ?.getAttribute("data-active-destination"),
    href: window.location.href,
    history: JSON.stringify(window.history.state),
  }));
  const minimizedTapBox = await requireBoundingBox(navigation);
  await page.touchscreen.tap(
    minimizedTapBox.x + minimizedTapBox.width / 2,
    minimizedTapBox.y + minimizedTapBox.height / 2,
  );
  await expect(navigation).toHaveAttribute("data-minimized", "false");
  expect(
    await page.evaluate(() => ({
      active: document
        .querySelector("[data-product-shell]")
        ?.getAttribute("data-active-destination"),
      href: window.location.href,
      history: JSON.stringify(window.history.state),
    })),
  ).toEqual(beforeExpandTap);
});

test("Mouse regression: navigation drag previews only the bubble and commits on release", async ({
  page,
}) => {
  const { navigation, surface } = await openDevelopmentSurface(page);
  await confirmMouseNavigationReady(surface, navigation);
  const homeButton = navigation.getByRole("button", {
    exact: true,
    name: "首页",
  });
  const discussionButton = navigation.getByRole("button", {
    exact: true,
    name: "讨论",
  });
  const homeCenter = await locatorCenter(homeButton);
  const discussionCenter = await locatorCenter(discussionButton);
  const committedHomePanel = surface.locator(
    '[data-primary-destination="home"]',
  );
  const committedPanelBeforeDrag = await committedHomePanel.boundingBox();
  const frozenProductState = await page.evaluate((historyVersion) => {
    const calls = { push: 0, replace: 0 };
    const initialState = window.history.state as {
      destination?: unknown;
      kind?: unknown;
      version?: unknown;
    } | null;
    let lastPrimaryDestination =
      initialState?.version === historyVersion &&
      initialState.kind === "primary"
        ? initialState.destination
        : null;
    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(
      window.history,
    );
    window.history.pushState = (...args) => {
      const state = args[0] as { kind?: unknown; version?: unknown } | null;
      if (state?.version === historyVersion && state.kind === "settings")
        calls.push += 1;
      return originalPushState(...args);
    };
    window.history.replaceState = (...args) => {
      const state = args[0] as {
        destination?: unknown;
        kind?: unknown;
        version?: unknown;
      } | null;
      if (state?.version === historyVersion && state.kind === "primary") {
        if (state.destination !== lastPrimaryDestination) {
          calls.replace += 1;
          lastPrimaryDestination = state.destination;
        }
      }
      return originalReplaceState(...args);
    };
    Object.assign(window, { __r01HistoryCalls: calls });
    return {
      ariaCurrent: document
        .querySelector('[data-primary-navigation] [aria-current="page"]')
        ?.getAttribute("aria-label"),
      focus:
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.dataset.primaryNavigationDestination ??
            document.activeElement.getAttribute("aria-label") ??
            document.activeElement.tagName)
          : null,
      href: window.location.href,
      scrollTop:
        document.querySelector<HTMLElement>('[data-primary-destination="home"]')
          ?.scrollTop ?? null,
      state: JSON.stringify(window.history.state),
    };
  }, 2);

  await trackPointerCaptureCalls(homeButton);

  await page.mouse.move(homeCenter.x, homeCenter.y);
  await page.mouse.down();
  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "0",
  );
  await page.mouse.move(homeCenter.x + 4, homeCenter.y);
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "0",
  );
  await page.mouse.move(discussionCenter.x, discussionCenter.y, {
    steps: 5,
  });

  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "1",
  );
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  await expect(navigation).toHaveAttribute("data-bubble-preview-index", /.+/);
  const previewIndex = Number(
    await navigation.getAttribute("data-bubble-preview-index"),
  );
  expect(previewIndex).toBeGreaterThanOrEqual(0.5);
  expect(previewIndex).toBeLessThanOrEqual(1.5);
  await expectActiveDestination(surface, "home");
  await expect(committedHomePanel).toHaveAttribute("data-active", "true");
  expect(await committedHomePanel.boundingBox()).toEqual(
    committedPanelBeforeDrag,
  );
  expect(
    await page.evaluate(() => ({
      ariaCurrent: document
        .querySelector('[data-primary-navigation] [aria-current="page"]')
        ?.getAttribute("aria-label"),
      calls: (
        window as typeof window & {
          __r01HistoryCalls: { push: number; replace: number };
        }
      ).__r01HistoryCalls,
      focus:
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.dataset.primaryNavigationDestination ??
            document.activeElement.getAttribute("aria-label") ??
            document.activeElement.tagName)
          : null,
      href: window.location.href,
      scrollTop:
        document.querySelector<HTMLElement>('[data-primary-destination="home"]')
          ?.scrollTop ?? null,
      state: JSON.stringify(window.history.state),
    })),
  ).toEqual({
    ariaCurrent: frozenProductState.ariaCurrent,
    calls: { push: 0, replace: 0 },
    focus: frozenProductState.focus,
    href: frozenProductState.href,
    scrollTop: frozenProductState.scrollTop,
    state: frozenProductState.state,
  });

  await page.mouse.up();

  await expectActiveDestination(surface, "discussion");
  await expect(homeButton).toHaveAttribute(
    "data-test-release-pointer-capture-count",
    "1",
  );
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(navigation).not.toHaveAttribute(
    "data-bubble-preview-index",
    /.+/,
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __r01HistoryCalls: { push: number; replace: number };
          }
        ).__r01HistoryCalls,
    ),
  ).toEqual({ push: 0, replace: 1 });
});

test("Synthetic touch pointer logic: passive candidate, intent threshold, and drag-click isolation", async ({
  page,
}) => {
  const { navigation, surface } = await openDevelopmentSurface(page);
  const homeButton = navigation.getByRole("button", {
    exact: true,
    name: "首页",
  });
  const discussionButton = navigation.getByRole("button", {
    exact: true,
    name: "讨论",
  });
  const userButton = navigation.getByRole("button", {
    exact: true,
    name: "用户",
  });
  const homeCenter = await locatorCenter(homeButton);
  const discussionCenter = await locatorCenter(discussionButton);

  await confirmMouseNavigationReady(surface, navigation);
  await trackPointerCaptureCalls(homeButton);
  await expect(navigation).toHaveCSS("touch-action", "pan-y");

  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 81,
    pointerType: "touch",
  });
  await expectActiveDestination(surface, "home");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(navigation).not.toHaveAttribute(
    "data-bubble-preview-index",
    /.+/,
  );
  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "0",
  );

  await homeButton.dispatchEvent("pointermove", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x + 8,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 81,
    pointerType: "touch",
  });
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await homeButton.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    clientX: homeCenter.x + 8,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 81,
    pointerType: "touch",
  });
  await discussionButton.click();
  await expectActiveDestination(surface, "discussion");
  await homeButton.click();
  await expectActiveDestination(surface, "home");

  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 82,
    pointerType: "touch",
  });
  await homeButton.dispatchEvent("pointermove", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x + 20,
    clientY: homeCenter.y + 30,
    isPrimary: true,
    pointerId: 82,
    pointerType: "touch",
  });
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "0",
  );
  await homeButton.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    clientX: homeCenter.x + 20,
    clientY: homeCenter.y + 30,
    isPrimary: true,
    pointerId: 82,
    pointerType: "touch",
  });
  await expectActiveDestination(surface, "home");

  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 83,
    pointerType: "touch",
  });
  await homeButton.dispatchEvent("pointermove", {
    button: 0,
    buttons: 1,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId: 83,
    pointerType: "touch",
  });
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  await expect(navigation).toHaveAttribute("data-bubble-preview-index", /.+/);
  await expect(homeButton).toHaveAttribute(
    "data-test-set-pointer-capture-count",
    "0",
  );
  await homeButton.evaluate((button, { x, y }) => {
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId: 83,
        pointerType: "touch",
      }),
    );
    button.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        button: 0,
        detail: 1,
      }),
    );
  }, discussionCenter);
  await expectActiveDestination(surface, "discussion");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await userButton.click();
  await expectActiveDestination(surface, "user");
});

test("Mouse and synthetic pointer regressions: current-item release and cancellation do not commit", async ({
  page,
}) => {
  const { navigation, surface } = await openDevelopmentSurface(page);
  await confirmMouseNavigationReady(surface, navigation);
  const homeButton = navigation.getByRole("button", {
    exact: true,
    name: "首页",
  });
  const discussionButton = navigation.getByRole("button", {
    exact: true,
    name: "讨论",
  });
  const homeCenter = await locatorCenter(homeButton);
  const discussionCenter = await locatorCenter(discussionButton);
  const sameItemPreviewX =
    homeCenter.x + (discussionCenter.x - homeCenter.x) * 0.35;

  await page.mouse.move(homeCenter.x, homeCenter.y);
  await page.mouse.down();
  await page.mouse.move(sameItemPreviewX, homeCenter.y, { steps: 5 });
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  await page.mouse.up();

  await expectActiveDestination(surface, "home");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");

  const pointerId = 71;
  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId,
    pointerType: "touch",
  });
  await navigation.dispatchEvent("pointermove", {
    button: 0,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId,
    pointerType: "touch",
  });
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  await navigation.dispatchEvent("pointercancel", {
    button: 0,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId,
    pointerType: "touch",
  });

  await expectActiveDestination(surface, "home");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(navigation).not.toHaveAttribute(
    "data-bubble-preview-index",
    /.+/,
  );

  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: true,
    pointerId: 72,
    pointerType: "touch",
  });
  await navigation.dispatchEvent("pointermove", {
    button: 0,
    buttons: 1,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId: 72,
    pointerType: "touch",
  });
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  await homeButton.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: homeCenter.x,
    clientY: homeCenter.y,
    isPrimary: false,
    pointerId: 73,
    pointerType: "touch",
  });
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await navigation.dispatchEvent("pointerup", {
    button: 0,
    buttons: 0,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId: 72,
    pointerType: "touch",
  });
  await expectActiveDestination(surface, "home");

  await homeButton.evaluate((button) => {
    button.addEventListener(
      "pointerdown",
      (event) => {
        button.dataset.testPointerId = String(
          (event as PointerEvent).pointerId,
        );
      },
      { once: true },
    );
  });
  await page.mouse.move(homeCenter.x, homeCenter.y);
  await page.mouse.down();
  await page.mouse.move(discussionCenter.x, discussionCenter.y, {
    steps: 5,
  });
  await expect(navigation).toHaveAttribute("data-dragging", "true");
  const capturedPointerId = Number(
    await homeButton.getAttribute("data-test-pointer-id"),
  );
  expect(Number.isFinite(capturedPointerId)).toBe(true);
  await homeButton.dispatchEvent("lostpointercapture", {
    button: 0,
    clientX: discussionCenter.x,
    clientY: discussionCenter.y,
    isPrimary: true,
    pointerId: capturedPointerId,
    pointerType: "mouse",
  });

  await expectActiveDestination(surface, "home");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await page.mouse.up();
  await expectActiveDestination(surface, "home");
});

test("Mouse regression: horizontal drag over Primary content never switches destination", async ({
  page,
}) => {
  const { navigation, surface } = await openDevelopmentSurface(page);
  const homePanel = surface.locator('[data-product-panel="home"]');
  const panelCenter = await locatorCenter(homePanel);

  await page.mouse.move(panelCenter.x, panelCenter.y);
  await page.mouse.down();
  await page.mouse.move(panelCenter.x + 120, panelCenter.y, { steps: 5 });
  await page.mouse.up();

  await expectActiveDestination(surface, "home");
  await expect(navigation).not.toHaveAttribute("data-dragging", "true");
  await expect(
    surface.locator('[data-primary-destination="home"]'),
  ).toHaveAttribute("data-active", "true");
});

import { spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { prepareFormalRoutes } from "./support/prepare-formal-routes";

import type { ChildProcess } from "node:child_process";
import type { Locator, Page } from "@playwright/test";

type HomeFeed = "calligraphy" | "discover" | "inscriptions";

const e2eRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(e2eRoot, "../..");
const sourceWebRoot = join(repositoryRoot, "apps/web");
const projectPorts = {
  "desktop-chromium": 3210,
  "desktop-webkit": 3211,
  "mobile-webkit": 3212,
  "tablet-landscape-webkit": 3214,
  "tablet-webkit": 3213,
} as const;
const projectApiPorts = {
  "desktop-chromium": 3220,
  "desktop-webkit": 3221,
  "mobile-webkit": 3222,
  "tablet-landscape-webkit": 3224,
  "tablet-webkit": 3223,
} as const;

const excludedWebEntries = new Set([
  ".next",
  ".turbo",
  "AGENTS.md",
  "CLAUDE.md",
  "node_modules",
  "tsconfig.tsbuildinfo",
]);

let pagingRuntime:
  | {
      readonly baseUrl: string;
      readonly children: readonly ChildProcess[];
      readonly logDescriptor: number;
      readonly temporaryRoot: string;
    }
  | undefined;

const waitForRuntime = async (baseUrl: string, child: ChildProcess) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Paging Formal runtime exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.status === 200) return;
    } catch {
      // The disposable server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Timed out starting the paging Formal runtime");
};

const startPagingRuntime = async (projectName: string) => {
  const port = projectPorts[projectName as keyof typeof projectPorts];
  const apiPort = projectApiPorts[projectName as keyof typeof projectApiPorts];
  if (port === undefined || apiPort === undefined) {
    throw new Error(`Unknown E2E project ${projectName}`);
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "moya-catalog-paging-"));
  const temporaryWebRoot = join(temporaryRoot, "apps/web");
  mkdirSync(join(temporaryRoot, "apps"), { recursive: true });
  cpSync(
    join(repositoryRoot, "tsconfig.base.json"),
    join(temporaryRoot, "tsconfig.base.json"),
  );
  cpSync(sourceWebRoot, temporaryWebRoot, {
    filter: (source) => {
      const pathFromWebRoot = relative(sourceWebRoot, source);
      const topLevelEntry = pathFromWebRoot.split(sep)[0] ?? "";
      return !excludedWebEntries.has(topLevelEntry);
    },
    recursive: true,
  });
  symlinkSync(join(repositoryRoot, "docs"), join(temporaryRoot, "docs"), "dir");
  symlinkSync(
    join(repositoryRoot, "packages"),
    join(temporaryRoot, "packages"),
    "dir",
  );
  symlinkSync(
    join(sourceWebRoot, "node_modules"),
    join(temporaryWebRoot, "node_modules"),
    "dir",
  );

  const logPath = join(tmpdir(), `moya-catalog-paging-${projectName}.log`);
  const logDescriptor = openSync(logPath, "w");
  const publicApiScript = join(e2eRoot, "support/public-api.ts");
  const apiChild = spawn(process.execPath, [publicApiScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MOYA_E2E_PUBLIC_API_PORT: String(apiPort),
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  const publicApiOrigin = `http://127.0.0.1:${apiPort}`;
  try {
    await waitForRuntime(`${publicApiOrigin}/health`, apiChild);
  } catch (error) {
    apiChild.kill("SIGTERM");
    closeSync(logDescriptor);
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  const nextCli = join(sourceWebRoot, "node_modules/next/dist/bin/next");
  const webChild = spawn(
    process.execPath,
    [
      nextCli,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: temporaryWebRoot,
      env: {
        ...process.env,
        MOYA_PUBLIC_API_BASE_URL: `${publicApiOrigin}/paging/`,
      },
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRuntime(baseUrl, webChild);
  } catch (error) {
    webChild.kill("SIGTERM");
    apiChild.kill("SIGTERM");
    closeSync(logDescriptor);
    rmSync(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
  pagingRuntime = {
    baseUrl,
    children: [webChild, apiChild],
    logDescriptor,
    temporaryRoot,
  };
};

const stopPagingRuntime = async () => {
  const runtime = pagingRuntime;
  pagingRuntime = undefined;
  if (runtime === undefined) return;
  await Promise.all(
    runtime.children.map(async (child) => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
        child.kill("SIGTERM");
      });
    }),
  );
  closeSync(runtime.logDescriptor);
  rmSync(runtime.temporaryRoot, { force: true, recursive: true });
};

const formalSurface = (page: Page) =>
  page.locator("[data-clean-product-preview]");

const productShell = (page: Page) =>
  formalSurface(page).locator("[data-product-shell]");

const feedSurface = (page: Page, feed: HomeFeed) =>
  productShell(page).locator(`[data-home-feed-panel="${feed}"]`);

const selectPrimary = async (page: Page, label: "首页" | "讨论") => {
  const navigation = formalSurface(page).getByRole("navigation", {
    name: "主要内容",
  });
  if ((await navigation.getAttribute("data-minimized")) === "true") {
    await navigation
      .locator('[data-primary-navigation-destination][aria-current="page"]')
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(navigation).toHaveAttribute("data-minimized", "false");
  }
  await navigation
    .getByRole("button", { exact: true, name: label })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(productShell(page)).toHaveAttribute(
    "data-active-destination",
    label === "首页" ? "home" : "discussion",
  );
};

const selectHomeFeed = async (
  page: Page,
  name: "书帖" | "碑刻" | "发现",
  feed: HomeFeed,
) => {
  if (
    (await productShell(page).getAttribute("data-active-destination")) !==
    "home"
  ) {
    await selectPrimary(page, "首页");
  }
  const home = productShell(page).locator("[data-home-surface]");
  await home
    .getByRole("tab", { exact: true, name })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(productShell(page)).toHaveAttribute(
    "data-active-destination",
    "home",
  );
  await expect(home).toHaveAttribute("data-active-home-feed", feed);
  await expect(feedSurface(page, feed)).toHaveAttribute("aria-hidden", "false");
  await expect(feedSurface(page, feed)).not.toHaveAttribute("inert", "");
  const pager = home.locator("[data-home-feed-pager]");
  // Business selection commits before the pager finishes restoring panel scroll.
  // Start a new reading offset only after that existing motion has settled.
  await expect
    .poll(
      () =>
        pager.evaluate(async (node, target) => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const panel = node.querySelector<HTMLElement>(
            `[data-home-feed-panel="${target}"]`,
          )!;
          return (
            (node as HTMLElement).dataset.homePagerScrolling === "false" &&
            Math.abs(
              panel.getBoundingClientRect().left -
                node.getBoundingClientRect().left,
            ) <= 2
          );
        }, feed),
      { intervals: [0] },
    )
    .toBe(true);
};

const settleFeedRestore = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolveFrames) => {
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() =>
            window.requestAnimationFrame(() => resolveFrames()),
          ),
        );
      }),
  );

const writeFeedScroll = async (
  page: Page,
  feed: HomeFeed,
  requestedTop: number,
) =>
  productShell(page).evaluate(
    (node, input) => {
      const shell = node as HTMLElement;
      const section = shell.querySelector<HTMLElement>(
        `[data-home-feed-panel="${input.feed}"]`,
      );
      if (section === null) throw new Error("Missing Home feed");
      const target =
        shell.dataset.platform === "pc"
          ? (document.scrollingElement as HTMLElement)
          : section;
      target.scrollTop = Math.min(
        input.requestedTop,
        Math.max(0, target.scrollHeight - target.clientHeight),
      );
      target.dispatchEvent(new Event("scroll"));
      if (shell.dataset.platform === "pc") {
        window.dispatchEvent(new Event("scroll"));
      }
      return target.scrollTop;
    },
    { feed, requestedTop },
  );

const readFeedScroll = async (page: Page, feed: HomeFeed) =>
  productShell(page).evaluate((node, requestedFeed) => {
    const shell = node as HTMLElement;
    const section = shell.querySelector<HTMLElement>(
      `[data-home-feed-panel="${requestedFeed}"]`,
    );
    if (section === null) throw new Error("Missing Home feed");
    return shell.dataset.platform === "pc"
      ? (document.scrollingElement?.scrollTop ?? 0)
      : section.scrollTop;
  }, feed);

const activateControlTwice = async (control: Locator) =>
  control.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

const openViewerAndReturn = async (
  page: Page,
  opener: Locator,
  title: string,
) => {
  // Record the actual entry offset atomically with opening Detail. Native
  // scrolling/layout may still move between separate Playwright round trips.
  const sourceTop = await opener.evaluate((button) => {
    const shell = button.closest<HTMLElement>("[data-product-shell]");
    const section = button.closest<HTMLElement>("[data-home-feed-panel]");
    if (shell === null || section === null) throw new Error("Missing source");
    const target =
      shell.dataset.platform === "pc"
        ? (document.scrollingElement as HTMLElement)
        : section;
    const top = target.scrollTop;
    (button as HTMLButtonElement).click();
    return top;
  });
  const detail = productShell(page).getByRole("dialog", { name: "资料详情" });
  await expect(detail).toBeVisible();
  await expect(detail.locator("[data-detail-title]")).toHaveText(title);
  await detail.locator("[data-detail-main-image]").click();
  const viewer = productShell(page).getByRole("dialog", { name: "图像查看" });
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { exact: true, name: "返回" }).click();
  await expect(detail).toHaveCount(0);
  await expect(opener).toBeFocused();
  return sourceTop;
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request }, workerInfo) => {
  void browser;
  await startPagingRuntime(workerInfo.project.name);
  // This spec owns a separate paging server, so the shared server's route
  // preparation cannot prevent its cold mounted routes from compiling mid-test.
  await prepareFormalRoutes(request, pagingRuntime!.baseUrl);
  const detail = await request.get(
    `${pagingRuntime!.baseUrl}/api/catalog/runtime-paging-inscription-22`,
  );
  expect(detail.status(), "Prepare paging Catalog Detail").toBe(200);
});

test.afterAll(async () => {
  await stopPagingRuntime();
});

test("Formal Home catalog feeds progressively load and retain later pages", async ({
  page,
}) => {
  if (pagingRuntime === undefined) throw new Error("Missing paging runtime");
  const response = await page.goto(pagingRuntime.baseUrl);
  expect(response?.status()).toBe(200);
  await expect(formalSurface(page)).toBeVisible();
  await expect(
    feedSurface(page, "discover").locator("[data-catalog-paging-control]"),
  ).toHaveCount(0);

  await selectHomeFeed(page, "碑刻", "inscriptions");
  const inscriptions = feedSurface(page, "inscriptions");
  // Inscriptions use the composed discovery feed: 12 rows and an after cursor.
  const inscriptionCards = inscriptions.locator(
    '[data-content-type="catalog"]',
  );
  const inscriptionControl = inscriptions.getByRole("button", {
    exact: true,
    name: "加载更多",
  });
  await expect(inscriptionCards).toHaveCount(12);
  await expect(inscriptionControl).toBeEnabled();
  await settleFeedRestore(page);

  let inscriptionPageTwoRequests = 0;
  await page.route("**/api/community/discover?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("kind") === "inscription" && query.get("after") === "12") {
      inscriptionPageTwoRequests += 1;
      expect(query.get("pageSize")).toBe("12");
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    await route.continue();
  });
  let inscriptionTop = 0;
  await expect
    .poll(async () => {
      inscriptionTop = await writeFeedScroll(page, "inscriptions", 220);
      return inscriptionTop;
    })
    .toBeGreaterThan(0);
  await activateControlTwice(inscriptionControl);
  await expect(inscriptionControl).toBeDisabled();
  await expect(inscriptions.getByRole("status", { name: "" })).toHaveText(
    "正在加载…",
  );
  await expect(inscriptionCards).toHaveCount(24);
  expect(inscriptionPageTwoRequests).toBe(1);
  expect(await readFeedScroll(page, "inscriptions")).toBe(inscriptionTop);
  await page.unroute("**/api/community/discover?*");
  await selectHomeFeed(page, "发现", "discover");
  await selectHomeFeed(page, "碑刻", "inscriptions");
  await expect(inscriptionCards).toHaveCount(24);

  const inscriptionRequestedCursors: string[] = [];
  let failPageThree = true;
  await page.route("**/api/community/discover?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("kind") === "inscription" && query.get("after") === "24") {
      inscriptionRequestedCursors.push(query.get("after") ?? "");
      if (failPageThree) {
        failPageThree = false;
        await route.fulfill({ status: 503 });
        return;
      }
    }
    await route.continue();
  });
  await inscriptionControl.evaluate((button) =>
    (button as HTMLButtonElement).click(),
  );
  await expect(inscriptions.getByRole("alert")).toBeVisible();
  await expect(inscriptionCards).toHaveCount(24);
  await inscriptions
    .getByRole("button", { exact: true, name: "重试" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(inscriptionCards).toHaveCount(36);
  expect(inscriptionRequestedCursors).toEqual(["24", "24"]);
  await page.unroute("**/api/community/discover?*");
  for (const count of [48, 55]) {
    await inscriptionControl.evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
    await expect(inscriptionCards).toHaveCount(count);
  }
  await expect(inscriptionControl).toHaveCount(0);
  const inscriptionIds = await inscriptionCards.evaluateAll((cards) =>
    cards.map((card) => (card as HTMLElement).dataset.contentId),
  );
  expect(new Set(inscriptionIds).size).toBe(55);

  const inscriptionOpener = inscriptions.locator(
    '[data-catalog-id="runtime-paging-inscription-22"] [data-open-catalog]',
  );
  await inscriptionOpener.scrollIntoViewIfNeeded();
  const inscriptionReturnTop = await openViewerAndReturn(
    page,
    inscriptionOpener,
    "分页碑刻 22",
  );
  expect(await readFeedScroll(page, "inscriptions")).toBe(inscriptionReturnTop);
  await selectHomeFeed(page, "发现", "discover");
  await selectHomeFeed(page, "碑刻", "inscriptions");
  await expect(inscriptionCards).toHaveCount(55);

  await selectHomeFeed(page, "书帖", "calligraphy");
  const calligraphy = feedSurface(page, "calligraphy");
  const allPanel = calligraphy.locator("[data-calligraphy-all]");
  const allCards = allPanel.locator("[data-catalog-card]");
  const calligraphyControl = allPanel.locator("[data-catalog-paging-control]");
  await expect(allCards).toHaveCount(24);
  await expect(calligraphyControl).toHaveCount(1);
  await expect(calligraphy.locator('[role="tablist"]')).toHaveCount(0);
  await settleFeedRestore(page);

  let calligraphyPageTwoRequests = 0;
  await page.route("**/api/catalog?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("kind") === "calligraphy" && query.get("page") === "2") {
      calligraphyPageTwoRequests += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    await route.continue();
  });
  let calligraphyTop = 0;
  await expect
    .poll(async () => {
      calligraphyTop = await writeFeedScroll(page, "calligraphy", 220);
      return calligraphyTop;
    })
    .toBeGreaterThan(0);
  await activateControlTwice(calligraphyControl);
  await expect(calligraphyControl).toHaveText("正在加载…");
  await expect(allCards).toHaveCount(48);
  expect(calligraphyPageTwoRequests).toBe(1);
  expect(await readFeedScroll(page, "calligraphy")).toBe(calligraphyTop);
  await page.unroute("**/api/catalog?*");

  // Catalogs now share Home's feed pager. Moving through another feed and
  // primary destination must preserve fetched records and their reading offset.
  await selectHomeFeed(page, "碑刻", "inscriptions");
  await expect(inscriptionCards).toHaveCount(55);
  await selectPrimary(page, "讨论");
  await selectHomeFeed(page, "书帖", "calligraphy");
  await expect(allCards).toHaveCount(48);
  await expect
    .poll(() => readFeedScroll(page, "calligraphy"))
    .toBe(calligraphyTop);

  const calligraphyOpener = allPanel.locator(
    '[data-catalog-id="runtime-paging-calligraphy-24"] [data-open-catalog]',
  );
  await calligraphyOpener.scrollIntoViewIfNeeded();
  const calligraphyReturnTop = await openViewerAndReturn(
    page,
    calligraphyOpener,
    "分页书帖 24",
  );
  await expect
    .poll(() => readFeedScroll(page, "calligraphy"))
    .toBe(calligraphyReturnTop);
  await selectHomeFeed(page, "碑刻", "inscriptions");
  await selectHomeFeed(page, "书帖", "calligraphy");
  await expect(allCards).toHaveCount(48);
});

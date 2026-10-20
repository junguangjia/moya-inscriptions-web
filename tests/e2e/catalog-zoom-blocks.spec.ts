import { expect, test } from "@playwright/test";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";

import type { Locator, Page, Request } from "@playwright/test";

/*
 * catalog-deep-zoom-v1 (Issue #295), criteria 12, 14–16 and 20: Catalog deep
 * zoom in the Formal Viewer, on the runtime fixture's `runtime-zoom-blocks`
 * record (1600 × 900 images over a ladder ending at 3200, with 6144 × 3456
 * block frames: 6 × 4 blocks) and `runtime-zoom-large` (8192 × 4608: 8 × 5).
 * Below the mount nothing is read; above it one list read per image, then
 * only the current image's visible blocks, at most four in flight and 24
 * decoded, drawn on device pixels without gaps; paging away aborts the old
 * image; a 404 list leaves today's Viewer; a large desktop at DPR 2 never
 * mounts the layer. The Detail itself never carries a block URL.
 */

// Compile the Development routes, this spec's two relays included, before a
// page subscribes to HMR: a route compiled mid-test reloads open pages.
test.beforeEach(async ({ request }) => {
  await prepareFormalRoutes(request);
  for (const path of [
    "/api/catalog/runtime-zoom-blocks",
    "/api/catalog/runtime-zoom-blocks/media/runtime-zoom-wide/zoom-blocks",
  ])
    expect((await request.get(path)).status(), `Prepare ${path}`).toBe(200);
});

const LIST = /\/api\/catalog\/[^/]+\/media\/[^/]+\/zoom-blocks$/u;
const BLOCK = /\/media\/zoom-blocks\/([^/]+)\/block-(\d{2})\.jpg$/u;

interface Traffic {
  readonly lists: string[];
  readonly blocks: { readonly media: string; readonly cell: number }[];
  maxInFlight: number;
}

/** Records list reads and block loads, with the most blocks in flight at once. */
const watchTraffic = (page: Page): Traffic => {
  const traffic: Traffic = { lists: [], blocks: [], maxInFlight: 0 };
  const inFlight = new Set<Request>();
  page.on("request", (request) => {
    const url = request.url();
    if (LIST.test(new URL(url).pathname)) traffic.lists.push(url);
    const block = BLOCK.exec(new URL(url).pathname);
    if (block) {
      traffic.blocks.push({ media: block[1]!, cell: Number(block[2]) });
      inFlight.add(request);
      traffic.maxInFlight = Math.max(traffic.maxInFlight, inFlight.size);
    }
  });
  const settle = (request: Request) => inFlight.delete(request);
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return traffic;
};

const openViewer = async (page: Page, catalogId: string, image: string) => {
  const response = await page.goto(`/?catalogId=${catalogId}&image=${image}`);
  expect(response?.status()).toBe(200);
  const viewer = page.getByRole("dialog", { name: "图像查看" });
  const stage = viewer.locator("[data-viewer-scale]");
  await expect(viewer).toBeVisible();
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await expect(stage).toHaveAttribute("data-viewer-zoom-blocks", /.+/u);
  return { viewer, stage };
};

/** Two-finger pinch on the stage, by synthetic touch pointers (as MIG-D2 does). */
const pincher = async (stage: Locator) => {
  const box = await stage.boundingBox();
  if (box === null) throw new Error("Missing Viewer geometry");
  const pointer = (
    type: "pointerdown" | "pointermove" | "pointerup",
    pointerId: number,
    x: number,
    isPrimary: boolean,
  ) =>
    stage.dispatchEvent(type, {
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: box.y + box.height / 2,
      isPrimary,
      pointerId,
      pointerType: "touch",
    });
  return async (from: number, to: number) => {
    const start = box.x + box.width * 0.3;
    await pointer("pointerdown", 801, start, true);
    await pointer("pointerdown", 802, start + box.width * from, false);
    await pointer("pointermove", 802, start + box.width * to, false);
    await pointer("pointerup", 802, start + box.width * to, false);
    await pointer("pointerup", 801, start, true);
  };
};

/** One-finger drag by `dx` CSS px, in steps. */
const drag = async (stage: Locator, dx: number) => {
  const box = await stage.boundingBox();
  if (box === null) throw new Error("Missing Viewer geometry");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  const event = (type: string, clientX: number) =>
    stage.dispatchEvent(type, {
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX,
      clientY: y,
      isPrimary: true,
      pointerId: 811,
      pointerType: "touch",
    });
  await event("pointerdown", x);
  for (let step = 1; step <= 12; step += 1)
    await event("pointermove", x + (dx * step) / 12);
  await event("pointerup", x + dx);
};

/**
 * Every shown block against its expected rectangle (from the base image's
 * contained box and the cell geometry), on device pixels, with no gap to its
 * right or lower neighbour.
 */
const blockGeometry = (viewer: Locator) =>
  viewer.evaluate((root) => {
    const image = root.querySelector<HTMLImageElement>(
      "[data-detail-viewer-image]",
    )!;
    const box = image.getBoundingClientRect();
    const aspect = 1600 / 900;
    const width = Math.min(box.width, box.height * aspect);
    const height = width / aspect;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    const frame = { width: 6144, height: 3456 };
    const columns = Math.ceil(frame.width / 1024);
    const dpr = window.devicePixelRatio;
    const blocks = [
      ...root.querySelectorAll<HTMLImageElement>("[data-viewer-zoom-block]"),
    ];
    const rects = new Map(
      blocks.map((block) => [
        Number(block.dataset.viewerZoomBlock),
        block.getBoundingClientRect(),
      ]),
    );
    let worst = 0;
    let offGrid = 0;
    let gaps = 0;
    for (const [cell, rect] of rects) {
      const x = (cell % columns) * 1024;
      const y = Math.floor(cell / columns) * 1024;
      const expected = {
        left: left + (x / frame.width) * width,
        top: top + (y / frame.height) * height,
        right: left + (Math.min(x + 1026, frame.width) / frame.width) * width,
        bottom:
          top + (Math.min(y + 1026, frame.height) / frame.height) * height,
      };
      worst = Math.max(
        worst,
        Math.abs(rect.left - expected.left),
        Math.abs(rect.top - expected.top),
        Math.abs(rect.right - expected.right),
        Math.abs(rect.bottom - expected.bottom),
      );
      // Snapped edges sit on device pixels, within two layout units (WebKit
      // lays out in 1/64 px, rounding both the position and the size); an
      // unsnapped edge is off by up to half a device pixel.
      const tolerance = (2 * dpr) / 64 + 0.01;
      for (const edge of [rect.left, rect.top, rect.right, rect.bottom])
        if (Math.abs(edge * dpr - Math.round(edge * dpr)) > tolerance)
          offGrid += 1;
      const right = rects.get(cell + 1);
      if (
        right !== undefined &&
        cell % columns !== columns - 1 &&
        right.left > rect.right + 0.01
      )
        gaps += 1;
      const below = rects.get(cell + columns);
      if (below !== undefined && below.top > rect.bottom + 0.01) gaps += 1;
    }
    return { count: rects.size, worst, offGrid, gaps };
  });

test.describe("Catalog deep zoom", () => {
  test("reads nothing below the mount; above it one list read, the current image's visible blocks, quiet at rest", async ({
    page,
  }, testInfo) => {
    const traffic = watchTraffic(page);
    // The Detail an Article or the article tool reads carries only frames.
    const detail = await page.request.get("/api/catalog/runtime-zoom-blocks");
    expect(detail.status()).toBe(200);
    const detailBody = await detail.text();
    expect(detailBody).toContain('"zoom":{"width":6144,"height":3456}');
    expect(detailBody).not.toMatch(/\/media\/zoom-blocks\/|block-\d{2}\.jpg/u);
    // The list itself stays within 13 KiB raw (criterion 20): 24 blocks here.
    const list = await page.request.get(
      "/api/catalog/runtime-zoom-blocks/media/runtime-zoom-wide/zoom-blocks",
    );
    expect(list.status()).toBe(200);
    const listBody = await list.text();
    expect(Buffer.byteLength(listBody)).toBeLessThanOrEqual(13 * 1024);
    expect((JSON.parse(listBody) as { srcs: string[] }).srcs).toHaveLength(24);

    const { viewer, stage } = await openViewer(
      page,
      "runtime-zoom-blocks",
      "runtime-zoom-wide",
    );
    await expect(stage).toHaveAttribute("data-viewer-zoom-blocks", "idle");
    const pinch = await pincher(stage);
    await pinch(0.1, 0.11);
    await page.waitForTimeout(1_000);
    expect(traffic.lists).toEqual([]);
    expect(traffic.blocks).toEqual([]);

    await pinch(0.1, 0.4);
    await expect.poll(() => traffic.lists.length).toBe(1);
    await expect
      .poll(() => viewer.locator("[data-viewer-zoom-block]").count())
      .toBeGreaterThan(0);
    await expect(stage).toHaveAttribute("data-viewer-zoom-blocks", "ready");
    expect(traffic.maxInFlight).toBeLessThanOrEqual(4);
    expect(
      traffic.blocks.every((block) => block.media === "runtime-zoom-wide"),
    ).toBe(true);
    expect(
      await viewer.locator("[data-viewer-zoom-block]").count(),
    ).toBeLessThanOrEqual(24);
    for (const [name, value] of [
      ["alt", ""],
      ["decoding", "async"],
    ] as const)
      await expect(
        viewer.locator("[data-viewer-zoom-block]").first(),
      ).toHaveAttribute(name, value);
    expect(
      await viewer.locator("[data-viewer-zoom-block][crossorigin]").count(),
    ).toBe(0);

    // Drawn on device pixels at its computed rectangle, without gaps, at
    // three zoom levels (criterion 16).
    for (const [level, factor] of [
      ["4x", 1],
      ["6x", 1.5],
      ["cap", 4],
    ] as const) {
      if (factor !== 1) await pinch(0.1, 0.1 * factor);
      await page.waitForTimeout(800);
      const geometry = await blockGeometry(viewer);
      expect(geometry.count, level).toBeGreaterThan(0);
      expect(geometry.worst, level).toBeLessThanOrEqual(1);
      expect(geometry.offGrid, level).toBe(0);
      expect(geometry.gaps, level).toBe(0);
      await testInfo.attach(`blocks-${level}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }

    // No new request after 2 s at rest, none after close, still one list read.
    await page.waitForTimeout(2_000);
    const atRest = traffic.blocks.length;
    await page.waitForTimeout(2_000);
    expect(traffic.blocks.length).toBe(atRest);
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(traffic.blocks.length).toBe(atRest);
    expect(traffic.lists).toHaveLength(1);
    expect(traffic.maxInFlight).toBeLessThanOrEqual(4);
  });

  test("pages from a pan edge while zoomed: the old image requests nothing more", async ({
    page,
  }) => {
    const traffic = watchTraffic(page);
    const { viewer, stage } = await openViewer(
      page,
      "runtime-zoom-blocks",
      "runtime-zoom-wide",
    );
    const pinch = await pincher(stage);
    await pinch(0.1, 0.4);
    await expect.poll(() => traffic.lists.length).toBe(1);
    await expect
      .poll(() => viewer.locator("[data-viewer-zoom-block]").count())
      .toBeGreaterThan(0);
    const box = await stage.boundingBox();
    // Swipe towards the next image (leftwards, or rightwards in "rtl"): the
    // zoomed image pans to that edge, then the next swipe pages (MIG-D2).
    const towardsNext =
      (await viewer.getAttribute("data-viewer-direction")) === "rtl" ? 1 : -1;
    for (let step = 0; step < 8; step += 1) {
      await drag(stage, towardsNext * box!.width * 0.9);
      await page.waitForTimeout(400);
      if (page.url().includes("image=runtime-zoom-second")) break;
    }
    await expect(page).toHaveURL(/image=runtime-zoom-second/u);
    const fromOld = traffic.blocks.filter(
      (block) => block.media === "runtime-zoom-wide",
    ).length;
    await page.waitForTimeout(2_000);
    expect(
      traffic.blocks.filter((block) => block.media === "runtime-zoom-wide")
        .length,
    ).toBe(fromOld);
    // The new image opens at fit: below the mount, nothing read for it.
    expect(traffic.lists).toHaveLength(1);
    expect(
      traffic.blocks.some((block) => block.media === "runtime-zoom-second"),
    ).toBe(false);
    expect(traffic.maxInFlight).toBeLessThanOrEqual(4);
  });

  test("a list read answering 404 leaves today's Viewer", async ({ page }) => {
    const traffic = watchTraffic(page);
    const { viewer, stage } = await openViewer(
      page,
      "runtime-zoom-blocks",
      "runtime-zoom-missing",
    );
    const pinch = await pincher(stage);
    await pinch(0.1, 0.4);
    await expect.poll(() => traffic.lists.length).toBe(1);
    await expect(stage).toHaveAttribute("data-viewer-zoom-blocks", "unusable");
    await page.waitForTimeout(1_000);
    expect(traffic.blocks).toEqual([]);
    await expect(viewer.locator("[data-detail-viewer-image]")).toBeVisible();
  });

  test("a scripted typical session makes at most 40 block requests", async ({
    page,
  }) => {
    const traffic = watchTraffic(page);
    const { stage } = await openViewer(
      page,
      "runtime-zoom-blocks",
      "runtime-zoom-wide",
    );
    const pinch = await pincher(stage);
    await pinch(0.1, 0.4);
    await page.waitForTimeout(800);
    await drag(stage, 120);
    await page.waitForTimeout(800);
    await drag(stage, -240);
    await page.waitForTimeout(800);
    await pinch(0.1, 0.15);
    await page.waitForTimeout(1_500);
    expect(traffic.blocks.length).toBeGreaterThan(0);
    expect(traffic.blocks.length).toBeLessThanOrEqual(40);
    expect(traffic.lists).toHaveLength(1);
  });
});

test("Catalog deep zoom mounts no layer on a 1920 × 1080 desktop at DPR 2", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "the DPR-2 desktop case runs once, on Chromium",
  );
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    baseURL: testInfo.project.use.baseURL!,
  });
  try {
    const page = await context.newPage();
    const traffic = watchTraffic(page);
    const { stage } = await openViewer(
      page,
      "runtime-zoom-large",
      "runtime-zoom-large-1",
    );
    const pinch = await pincher(stage);
    await pinch(0.1, 0.4);
    await page.waitForTimeout(1_500);
    await expect(stage).toHaveAttribute("data-viewer-zoom-blocks", "unusable");
    expect(traffic.lists).toEqual([]);
    expect(traffic.blocks).toEqual([]);
  } finally {
    await context.close();
  }
});

import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop continuous gallery only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const width of [3440, 5120]) {
  test(`continuous real paging has no sparse page-boundary rows at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1440 });
    await page.goto(
      `http://127.0.0.1:${readPagingWebPort()}/?feed=inscriptions`,
    );
    const panel = page.locator('[data-home-feed-panel="inscriptions"]');
    const feed = panel.locator("[data-desktop-feed]");
    await expect(feed).toHaveAttribute("data-layout-ready", "true");
    const cards = feed.locator("[data-desktop-feed-item]");
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(12);
    for (
      let pageNumber = 0;
      pageNumber < 4 && (await cards.count()) < 36;
      pageNumber++
    ) {
      const before = await cards.count();
      // The sentinel can finish every remaining page while scrolling. Its
      // footer button then unmounts; an existing keyed card stays attached.
      await cards.nth(before - 1).scrollIntoViewIfNeeded();
      await expect.poll(() => cards.count()).toBeGreaterThan(before);
    }
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(36);
    const geometry = await feed.evaluate((root) => {
      const box = root.getBoundingClientRect();
      return {
        width: box.width,
        items: Array.from(
          root.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
        ).map((n) => {
          const b = n.getBoundingClientRect();
          return {
            key: n.dataset.desktopFeedKey,
            x: b.x - box.x,
            y: b.y - box.y,
            w: b.width,
            h: b.height,
          };
        }),
      };
    });
    const rows = new Map<number, typeof geometry.items>();
    for (const item of geometry.items) {
      const y = Math.round(item.y);
      rows.set(y, [...(rows.get(y) ?? []), item]);
    }
    for (const row of rows.values()) {
      expect(Math.min(...row.map((n) => n.x))).toBeLessThan(1);
      expect(Math.max(...row.map((n) => n.x + n.w))).toBeGreaterThan(
        geometry.width - 1,
      );
      for (let i = 1; i < row.length; i++)
        expect(
          Math.abs(row[i - 1]!.x - row[i]!.x - row[i]!.w - 12),
        ).toBeLessThan(1);
    }
    const ordered = [...rows].sort(([a], [b]) => a - b);
    for (let i = 1; i < ordered.length; i++) {
      const [previousY, previous] = ordered[i - 1]!;
      expect(
        Math.abs(ordered[i]![0] - previousY - previous[0]!.h - 16),
      ).toBeLessThan(1);
    }
    expect(new Set(geometry.items.map((n) => n.key)).size).toBe(
      geometry.items.length,
    );
    await cards.first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`continuous-gallery-${width}.png`),
      animations: "disabled",
    });
  });
}

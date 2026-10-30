import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop natural-aspect masonry only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const width of [3440, 5120]) {
  test(`real paging retains its prefix and packs continuous RTL columns at ${width}px`, async ({
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
    const prefix = await cards.evaluateAll((nodes) =>
      nodes.map((node) => {
        const n = node as HTMLElement;
        return { key: n.dataset.desktopFeedKey, geometry: n.style.cssText };
      }),
    );
    for (
      let pageNumber = 0;
      pageNumber < 4 && (await cards.count()) < 36;
      pageNumber++
    ) {
      const before = await cards.count();
      // In masonry the last DOM card need not end at the tallest column.
      // Bring the real feed/footer boundary into the observer's margin.
      await feed.evaluate((root) =>
        root.scrollIntoView({ block: "end", inline: "nearest" }),
      );
      await expect.poll(() => cards.count()).toBeGreaterThan(before);
    }
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(36);
    expect(
      await cards.evaluateAll(
        (nodes, count) =>
          nodes.slice(0, count).map((node) => {
            const n = node as HTMLElement;
            return { key: n.dataset.desktopFeedKey, geometry: n.style.cssText };
          }),
        prefix.length,
      ),
    ).toEqual(prefix);
    const geometry = await feed.evaluate((root) => {
      const box = root.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        items: Array.from(
          root.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
        ).map((n) => {
          const b = n.getBoundingClientRect();
          const article = n.querySelector<HTMLElement>('[role="listitem"]')!;
          const frame = article.getBoundingClientRect();
          const caption = article.firstElementChild!.getBoundingClientRect();
          const title = article.querySelector("h3");
          const excerpt = article.querySelector("[data-card-caption-excerpt]");
          return {
            key: n.dataset.desktopFeedKey,
            x: b.x - box.x,
            y: b.y - box.y,
            w: b.width,
            h: b.height,
            frameError: Math.max(
              Math.abs(frame.x - b.x),
              Math.abs(frame.y - b.y),
              Math.abs(frame.width - b.width),
              Math.abs(frame.height - b.height),
            ),
            captionRightError: Math.abs(caption.right - frame.right),
            captionWidth: caption.width,
            titleWriting: title ? getComputedStyle(title).writingMode : null,
            excerptWriting: excerpt
              ? getComputedStyle(excerpt).writingMode
              : null,
          };
        }),
      };
    });
    const columns = new Map<number, typeof geometry.items>();
    for (const item of geometry.items) {
      const x = Math.round(item.x);
      columns.set(x, [...(columns.get(x) ?? []), item]);
      expect(item.frameError).toBeLessThan(1);
      expect(item.captionRightError).toBeLessThan(1);
      expect(item.captionWidth).toBeCloseTo(72, 0);
      if (item.titleWriting) expect(item.titleWriting).toBe("vertical-rl");
      if (item.excerptWriting) expect(item.excerptWriting).toBe("vertical-rl");
      expect(item.x).toBeGreaterThanOrEqual(-0.1);
      expect(item.x + item.w).toBeLessThanOrEqual(geometry.width + 0.1);
      expect(item.h).toBeGreaterThan(0);
      expect(item.h).toBeLessThanOrEqual(721);
    }
    expect(columns.size).toBeGreaterThan(8);
    const ordered = [...columns].sort(([a], [b]) => a - b);
    for (let index = 0; index < ordered.length; index++) {
      const [, column] = ordered[index]!;
      expect(column[0]!.y).toBeLessThan(1);
      for (let card = 1; card < column.length; card++)
        expect(
          Math.abs(
            column[card]!.y - column[card - 1]!.y - column[card - 1]!.h - 12,
          ),
        ).toBeLessThan(1);
      if (index > 0) {
        const previous = ordered[index - 1]![1][0]!;
        expect(
          Math.abs(column[0]!.x - previous.x - previous.w - 12),
        ).toBeLessThan(1);
      }
    }
    for (let index = 1; index < geometry.items.length; index++)
      expect(geometry.items[index]!.y).toBeGreaterThanOrEqual(
        geometry.items[index - 1]!.y - 0.1,
      );
    expect(
      Math.abs(
        geometry.height - Math.max(...geometry.items.map((n) => n.y + n.h)),
      ),
    ).toBeLessThan(1);
    expect(new Set(geometry.items.map((n) => n.key)).size).toBe(
      geometry.items.length,
    );
    await cards.first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`masonry-gallery-${width}.png`),
      animations: "disabled",
    });
  });
}

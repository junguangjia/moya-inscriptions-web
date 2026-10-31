import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop balanced natural-aspect rows only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const width of [3440, 5120]) {
  test(`real paging retains its source identity and balances RTL rows at ${width}px`, async ({
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
      nodes.map((node) => (node as HTMLElement).dataset.desktopFeedKey),
    );
    const prefixNodes = (await cards.elementHandles()).slice(0, prefix.length);
    for (
      let pageNumber = 0;
      pageNumber < 4 && (await cards.count()) < 36;
      pageNumber++
    ) {
      const before = await cards.count();
      // Pagination intentionally scrolls to the real footer. Key/DOM identity
      // stays stable, while ordered rows may rebalance their pixel positions.
      await feed.evaluate((root) =>
        root.scrollIntoView({ block: "end", inline: "nearest" }),
      );
      await expect.poll(() => cards.count()).toBeGreaterThan(before);
    }
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(36);
    expect(
      await cards.evaluateAll(
        (nodes, count) =>
          nodes
            .slice(0, count)
            .map((node) => (node as HTMLElement).dataset.desktopFeedKey),
        prefix.length,
      ),
    ).toEqual(prefix);
    for (const node of prefixNodes) {
      expect(
        await node.evaluate(
          (element) =>
            element.isConnected &&
            (element as Element).closest("[data-desktop-feed]") !== null,
        ),
      ).toBe(true);
      await node.dispose();
    }
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
          const captionNode = article.querySelector<HTMLElement>(
            "[data-card-caption]",
          )!;
          const caption = captionNode.getBoundingClientRect();
          const image = article
            .querySelector<HTMLElement>("[data-card-media-frame]")!
            .getBoundingClientRect();
          const surface = getComputedStyle(article);
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
            mediaFrameError: Math.max(
              Math.abs(image.x - frame.x),
              Math.abs(image.y - frame.y),
              Math.abs(image.right - caption.left),
              Math.abs(image.width - (frame.width - caption.width)),
              Math.abs(image.height - frame.height),
            ),
            borderWidth: surface.borderWidth,
            outlineWidth: surface.outlineWidth,
            shadow: surface.boxShadow,
            captionPosition: getComputedStyle(captionNode).position,
            captionPointerEvents: getComputedStyle(captionNode).pointerEvents,
            captionRightError: Math.abs(caption.right - frame.right),
            captionWidth: caption.width,
            mediaWidth: image.width,
            titleWriting: title ? getComputedStyle(title).writingMode : null,
            excerptWriting: excerpt
              ? getComputedStyle(excerpt).writingMode
              : null,
          };
        }),
      };
    });
    const rows = new Map<number, typeof geometry.items>();
    for (const item of geometry.items) {
      const y = Math.round(item.y * 100);
      rows.set(y, [...(rows.get(y) ?? []), item]);
      expect(item.frameError).toBeLessThan(1);
      expect(item.mediaFrameError).toBeLessThan(1);
      expect(item.borderWidth).toBe("0px");
      expect(item.outlineWidth).toBe("0px");
      expect(item.shadow).not.toBe("none");
      expect(item.captionPosition).toBe("static");
      expect(item.captionPointerEvents).toBe("none");
      expect(item.captionRightError).toBeLessThan(1);
      expect(item.captionWidth).toBeCloseTo(72, 0);
      if (item.titleWriting) expect(item.titleWriting).toBe("vertical-rl");
      if (item.excerptWriting) expect(item.excerptWriting).toBe("vertical-rl");
      expect(item.x).toBeGreaterThanOrEqual(-0.1);
      expect(item.x + item.w).toBeLessThanOrEqual(geometry.width + 0.1);
      expect(item.h).toBeGreaterThan(0);
      expect(item.h).toBeLessThanOrEqual(361);
    }
    const ordered = [...rows].sort(([a], [b]) => a - b).map(([, row]) => row);
    for (let rowIndex = 0; rowIndex < ordered.length; rowIndex++) {
      const row = ordered[rowIndex]!;
      expect(Math.abs(row[0]!.x + row[0]!.w - geometry.width)).toBeLessThan(1);
      for (let index = 0; index < row.length; index++) {
        expect(Math.abs(row[index]!.h - row[0]!.h)).toBeLessThan(1);
        if (index > 0)
          expect(
            Math.abs(row[index - 1]!.x - row[index]!.x - row[index]!.w - 12),
          ).toBeLessThan(1);
      }
      const ratioSum = row.reduce(
        (sum, item) => sum + item.mediaWidth / item.h,
        0,
      );
      const captionWidth = row.reduce(
        (sum, item) => sum + item.captionWidth,
        0,
      );
      const fullHeight =
        (geometry.width - captionWidth - 12 * (row.length - 1)) / ratioSum;
      if (fullHeight < 359.5) expect(Math.abs(row.at(-1)!.x)).toBeLessThan(1);
      if (Math.abs(row.at(-1)!.x) >= 1) {
        // Only a truly infeasible/sparse group may retain bounded natural
        // widths; a terminal row does not receive an unconditional exemption.
        expect(fullHeight).toBeGreaterThan(359.5);
        expect(row[0]!.h).toBeCloseTo(240, 0);
        expect(row.at(-1)!.x).toBeGreaterThan(0);
      }
      if (rowIndex > 0) {
        const previous = ordered[rowIndex - 1]![0]!;
        expect(Math.abs(row[0]!.y - previous.y - previous.h - 12)).toBeLessThan(
          1,
        );
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
      path: info.outputPath(`balanced-gallery-${width}.png`),
      animations: "disabled",
    });
  });
}

import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop comparable whole-card masonry only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const width of [3440, 5120]) {
  test(`real paging keeps its prefix and comparable whole-card areas at ${width}px`, async ({
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
      nodes.map((node) => ({
        key: (node as HTMLElement).dataset.desktopFeedKey,
        geometry: (node as HTMLElement).style.cssText,
      })),
    );
    const prefixNodes = (await cards.elementHandles()).slice(0, prefix.length);
    for (
      let pageNumber = 0;
      pageNumber < 4 && (await cards.count()) < 36;
      pageNumber++
    ) {
      const before = await cards.count();
      // Pagination intentionally scrolls to the real footer. Sequential packing
      // preserves the prefix geometry as well as its keys and native nodes.
      await feed.evaluate((root) =>
        root.scrollIntoView({ block: "end", inline: "nearest" }),
      );
      await expect.poll(() => cards.count()).toBeGreaterThan(before);
    }
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(36);
    expect(
      await cards.evaluateAll(
        (nodes, count) =>
          nodes.slice(0, count).map((node) => ({
            key: (node as HTMLElement).dataset.desktopFeedKey,
            geometry: (node as HTMLElement).style.cssText,
          })),
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
    const targetArea = Math.max(
      52000,
      Math.min(100000, 100000 * (geometry.width / 1000) ** 2),
    );
    for (const item of geometry.items) {
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
      expect(item.h).toBeLessThanOrEqual(421);
      expect(item.w).toBeLessThanOrEqual(Math.min(580, geometry.width) + 1);
      expect(item.w * item.h).toBeGreaterThanOrEqual(targetArea * 0.8 - 50);
      expect(item.w * item.h).toBeLessThanOrEqual(targetArea * 1.2 + 50);
    }
    expect(
      Math.abs(geometry.items[0]!.x + geometry.items[0]!.w - geometry.width),
    ).toBeLessThan(1);
    for (let index = 0; index < geometry.items.length; index++) {
      const item = geometry.items[index]!;
      if (index > 0) {
        const previous = geometry.items[index - 1]!;
        expect(item.y).toBeGreaterThanOrEqual(previous.y - 0.1);
        if (item.y <= previous.y + 0.5)
          expect(item.x + item.w + 12).toBeLessThanOrEqual(previous.x + 0.1);
      }
      for (const earlier of geometry.items.slice(0, index)) {
        const separated =
          item.x + item.w + 12 <= earlier.x + 0.1 ||
          earlier.x + earlier.w + 12 <= item.x + 0.1 ||
          item.y + item.h + 12 <= earlier.y + 0.1 ||
          earlier.y + earlier.h + 12 <= item.y + 0.1;
        expect(separated).toBe(true);
      }
    }
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
      path: info.outputPath(`equal-area-gallery-${width}.png`),
      animations: "disabled",
    });
  });
}

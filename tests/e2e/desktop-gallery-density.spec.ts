import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";

test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.project.name.startsWith("desktop"),
    "Desktop full-image mosaic only",
  );
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const [width, kind] of [
  [3440, "inscriptions"],
  [5120, "calligraphy"],
] as const) {
  test(`real paging retains native content and a full-image mosaic in ${kind} at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1440 });
    await page.goto(`http://127.0.0.1:${readPagingWebPort()}/?feed=${kind}`);
    const panel = page.locator(`[data-home-feed-panel="${kind}"]`);
    const feed = panel.locator("[data-desktop-feed]");
    await expect(feed).toHaveAttribute("data-layout-ready", "true");
    const cards = feed.locator("[data-desktop-feed-item]");
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(12);
    const prefix = await cards.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.desktopFeedKey),
    );
    const prefixNodes = (await cards.elementHandles()).slice(0, prefix.length);
    for (
      let pageNumber = 0;
      pageNumber < 4 && (await cards.count()) < 36;
      pageNumber++
    ) {
      const before = await cards.count();
      // Preserve each category's existing owner: Catalog calligraphy has an
      // explicit paging control; discovery inscriptions load at their footer.
      if (kind === "calligraphy")
        await panel
          .getByRole("button", { name: "继续加载", exact: true })
          .click();
      else
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
            .map((n) => (n as HTMLElement).dataset.desktopFeedKey),
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
        items: [
          ...root.querySelectorAll<HTMLElement>("[data-desktop-feed-item]"),
        ].map((n) => {
          const b = n.getBoundingClientRect();
          const article = n.querySelector<HTMLElement>('[role="listitem"]')!;
          const frame = article.getBoundingClientRect();
          const captionNode = article.querySelector<HTMLElement>(
            "[data-card-caption]",
          )!;
          const caption = captionNode.getBoundingClientRect();
          const media = article
            .querySelector<HTMLElement>("[data-card-media-frame]")!
            .getBoundingClientRect();
          const title = article.querySelector<HTMLElement>(
            "[data-card-title-primary]",
          );
          const suffix = article.querySelector<HTMLElement>(
            "[data-card-title-suffix]",
          );
          const excerpt = article.querySelector<HTMLElement>(
            "[data-card-caption-excerpt]",
          );
          const img = article.querySelector("img");
          const surface = getComputedStyle(article);
          return {
            key: n.dataset.desktopFeedKey,
            x: b.x - box.x,
            y: b.y - box.y,
            logicalY: Number.parseFloat(n.style.top),
            w: b.width,
            h: b.height,
            frameError: Math.max(
              Math.abs(frame.x - b.x),
              Math.abs(frame.y - b.y),
              Math.abs(frame.width - b.width),
              Math.abs(frame.height - b.height),
            ),
            mediaFrameError: Math.max(
              Math.abs(media.x - frame.x),
              Math.abs(media.y - frame.y),
              Math.abs(media.right - caption.left),
              Math.abs(media.width - (frame.width - caption.width)),
              Math.abs(media.height - frame.height),
            ),
            border: surface.borderWidth,
            outline: surface.outlineWidth,
            shadow: surface.boxShadow,
            radius: surface.borderRadius,
            captionPosition: getComputedStyle(captionNode).position,
            captionPointer: getComputedStyle(captionNode).pointerEvents,
            captionRightError: Math.abs(caption.right - frame.right),
            captionWidth: caption.width,
            titleWriting: title ? getComputedStyle(title).writingMode : null,
            titleWeight: title ? getComputedStyle(title).fontWeight : null,
            suffixWriting: suffix ? getComputedStyle(suffix).writingMode : null,
            descriptionLinked: excerpt
              ? (article.getAttribute("aria-describedby") ?? "")
                  .split(" ")
                  .includes(excerpt.id)
              : null,
            imageFit: img ? getComputedStyle(img).objectFit : null,
          };
        }),
      };
    });
    for (const item of geometry.items) {
      expect(item.frameError).toBeLessThan(1);
      expect(item.mediaFrameError).toBeLessThan(1);
      expect(item.border).toBe("0px");
      expect(item.outline).toBe("0px");
      expect(item.shadow).not.toBe("none");
      expect(item.radius).toBe("18px");
      expect(item.captionPosition).toBe("relative");
      expect(item.captionPointer).toBe("none");
      expect(item.captionRightError).toBeLessThan(1);
      expect(item.captionWidth).toBeCloseTo(96, 0);
      if (item.titleWriting) expect(item.titleWriting).toBe("vertical-rl");
      if (item.titleWeight) expect(item.titleWeight).toBe("400");
      if (item.suffixWriting) expect(item.suffixWriting).toBe("vertical-rl");
      if (item.descriptionLinked !== null)
        expect(item.descriptionLinked).toBe(true);
      if (item.imageFit) expect(item.imageFit).toBe("contain");
      expect(item.x).toBeGreaterThanOrEqual(-0.1);
      expect(item.x + item.w).toBeLessThanOrEqual(geometry.width + 0.1);
      expect(item.h).toBeGreaterThan(0);
      expect(item.h).toBeLessThanOrEqual(641);
      expect(item.w).toBeGreaterThan(96);
    }
    await expect(
      feed.getByRole("img", { name: "局部预览 · 打开查看全图", exact: true }),
    ).toHaveCount(0);
    expect(
      Math.abs(geometry.items[0]!.x + geometry.items[0]!.w - geometry.width),
    ).toBeLessThan(1);
    for (let index = 0; index < geometry.items.length; index++) {
      const item = geometry.items[index]!;
      if (index > 0) {
        const previous = geometry.items[index - 1]!;
        expect(item.y).toBeGreaterThanOrEqual(previous.y - 0.1);
        if (item.logicalY === previous.logicalY)
          expect(item.x + item.w + 16).toBeLessThanOrEqual(previous.x + 0.1);
      }
      for (const earlier of geometry.items.slice(0, index)) {
        expect(
          item.x + item.w + 16 <= earlier.x + 0.1 ||
            earlier.x + earlier.w + 16 <= item.x + 0.1 ||
            item.y + item.h + 16 <= earlier.y + 0.1 ||
            earlier.y + earlier.h + 16 <= item.y + 0.1,
        ).toBe(true);
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
      path: info.outputPath(`full-image-mosaic-${kind}-${width}.png`),
      animations: "disabled",
    });
  });
}

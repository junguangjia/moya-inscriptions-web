import { expect, test } from "@playwright/test";
import { readPagingWebPort } from "./support/e2e-ports";
import type { Route } from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "Desktop gallery only");
  test.setTimeout(45_000);
  await page.addInitScript(() =>
    localStorage.setItem("yoyi.desktop-feed-layout.v1", "single"),
  );
});

for (const overlay of ["detail", "settings"] as const) {
  test(`a pending page stays visually held under ${overlay} and joins after return`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    const waiting = new Map<string, () => void>();
    let releaseAll = false;
    const pages = async (route: Route) => {
      const query = new URL(route.request().url()).searchParams;
      const after = query.get("after") ?? "0";
      if (query.get("kind") === "inscription" && after !== "0" && !releaseAll)
        await new Promise<void>((resolve) => waiting.set(after, resolve));
      await route.continue();
    };
    await page.route("**/api/community/discover?*", pages);
    try {
      await page.goto(
        `http://127.0.0.1:${readPagingWebPort()}/?feed=inscriptions`,
      );
      const shell = page.locator("[data-product-shell]");
      const feed = page.locator(
        '[data-home-feed-panel="inscriptions"] [data-desktop-feed]',
      );
      const cards = feed.locator("[data-desktop-feed-item]");
      await expect(feed).toHaveAttribute("data-layout-ready", "true");
      await expect(cards).toHaveCount(12);
      await page
        .getByRole("button", { name: "加载更多", exact: true })
        .scrollIntoViewIfNeeded();
      await expect.poll(() => waiting.has("12")).toBe(true);
      const opener = cards.first().getByRole("button", { name: /^打开/ });
      await opener.scrollIntoViewIfNeeded();
      const styles = await cards.evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).style.cssText),
      );
      const oldHeight = await feed.evaluate((node) =>
        Number.parseFloat((node as HTMLElement).style.height),
      );
      const settings = page.getByRole("button", { name: "设置", exact: true });
      const oldTop = (await opener.boundingBox())!.y;
      if (overlay === "detail") await opener.click();
      else await settings.click();
      const dialog = page.getByRole("dialog", {
        name: overlay === "detail" ? "资料详情" : "设置",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        page.locator("[data-product-primary-layer]"),
      ).toHaveAttribute("inert", "");
      const arrived = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/community/discover" &&
          url.searchParams.get("kind") === "inscription" &&
          url.searchParams.get("after") === "12"
        );
      });
      waiting.get("12")!();
      const response = await arrived;
      expect(response.status()).toBe(200);
      await response.finished();
      // Pending extent advances the existing footer, while covered cards keep
      // their original geometry and identity.
      await expect
        .poll(() =>
          feed.evaluate((node) =>
            Number.parseFloat((node as HTMLElement).style.height),
          ),
        )
        .toBeGreaterThan(oldHeight);
      await expect(cards).toHaveCount(12);
      expect(
        await cards.evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLElement).style.cssText),
        ),
      ).toEqual(styles);
      await dialog.getByRole("button", { name: "返回", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(shell).not.toHaveAttribute("data-scroll-restoring", "");
      await expect(cards).toHaveCount(24);
      if (overlay === "detail") {
        await expect(opener).toBeFocused();
        expect(Math.abs((await opener.boundingBox())!.y - oldTop)).toBeLessThan(
          2,
        );
      } else await expect(settings).toBeFocused();
    } finally {
      releaseAll = true;
      for (const release of waiting.values()) release();
      await page.unroute("**/api/community/discover?*", pages);
    }
  });
}

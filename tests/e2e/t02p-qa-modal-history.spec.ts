import { expect, test } from "@playwright/test";

for (const query of ["", "?qaChrome=hidden"] as const) {
  test(`Forward Detail owns keyboard above retained QA Search (${query || "normal"})`, async ({
    page,
    browserName,
  }, testInfo) => {
    const macWebKit = browserName === "webkit" && process.platform === "darwin";
    const tabAll = macWebKit ? "Alt+Tab" : "Tab";
    const shiftTabAll = macWebKit ? "Alt+Shift+Tab" : "Shift+Tab";
    const pageErrors: string[] = [];
    const keys: { key: string; trusted: boolean; prevented: boolean }[] = [];
    let recordKeys = false;
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.exposeFunction(
      "recordQaHistoryKey",
      (record: (typeof keys)[number]) => {
        if (recordKeys) keys.push(record);
      },
    );
    await page.addInitScript(() => {
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Tab" && event.key !== "Escape") return;
          void (
            window as typeof window & {
              recordQaHistoryKey: (record: {
                key: string;
                trusted: boolean;
                prevented: boolean;
              }) => Promise<void>;
            }
          ).recordQaHistoryKey({
            key: event.key,
            trusted: event.isTrusted,
            prevented: event.defaultPrevented,
          });
        },
        { passive: true },
      );
    });
    try {
      expect((await page.goto(`/dev/t02p/qa${query}`))?.status()).toBe(200);
      const shell = page.locator("[data-product-shell]");
      await expect(shell.locator("[data-product-boot]")).toHaveCount(0);
      const home = shell.locator("[data-home-surface]");
      if (query === "") {
        // The normal QA aside covers top tabs. Reach the selected tab through
        // native traversal, then use its End shortcut to select Calligraphy.
        const selectedTab = home.getByRole("tab", {
          name: "发现",
          exact: true,
        });
        for (let step = 0; step < 80; step += 1) {
          if (
            await selectedTab.evaluate(
              (node) => node === document.activeElement,
            )
          )
            break;
          await page.keyboard.press(tabAll);
        }
        await expect(selectedTab).toBeFocused();
        await page.keyboard.press("End");
      } else await home.getByRole("tab", { name: "书帖", exact: true }).click();
      // Home feeds are pre-mounted. Attached cards do not prove that the
      // asynchronous feed navigation has committed and released isolation.
      await expect(shell).toHaveAttribute("data-active-destination", "home");
      await expect(home).toHaveAttribute(
        "data-active-home-feed",
        "calligraphy",
      );
      const calligraphy = home.locator('[data-home-feed-panel="calligraphy"]');
      await expect(calligraphy).toHaveAttribute("aria-hidden", "false");
      await expect(calligraphy).not.toHaveAttribute("inert", "");
      const opener = calligraphy.locator(
        '[data-calligraphy-all] [data-catalog-id="qa-visual-calligraphy-01"] [data-open-catalog]',
      );
      // Masonry cards are attached before their first measured layout, with
      // visibility:hidden. Keyboard traversal must start after that real UI
      // precondition, not consume its bounded steps on invisible cards.
      await expect(opener).toBeVisible();
      if (query === "") {
        // The ordinary QA controls intentionally occupy the first card's hit
        // area. Reach it using native keyboard navigation, not forced clicks,
        // manual focus, or hidden controls.
        for (let step = 0; step < 80; step += 1) {
          if (await opener.evaluate((node) => node === document.activeElement))
            break;
          await page.keyboard.press(tabAll);
        }
        await expect(opener).toBeFocused();
        await page.keyboard.press("Enter");
      } else {
        await opener.click();
      }
      const detail = shell.getByRole("dialog", { name: "资料详情" });
      const back = detail.getByRole("button", { name: "返回", exact: true });
      await expect(back).toBeFocused();
      await back.click();
      await expect(detail).toHaveCount(0);
      await expect(opener).toBeFocused();
      const trigger = shell.locator("[data-search-trigger]");
      await trigger.click();
      const search = shell.locator("[data-search-panel]");
      const input = search.getByRole("searchbox", { name: "搜索关键词" });
      await expect(input).toBeFocused();

      recordKeys = true;
      await page.goForward();
      await expect(detail).toBeVisible();
      await expect(back).toBeFocused();
      await expect(search).toHaveCount(1);
      await expect(
        shell.locator("[data-product-primary-layer]"),
      ).toHaveAttribute("inert", "");
      await page.keyboard.press("Tab");
      await expect(
        back,
        "inert Search must not swallow Detail Tab",
      ).not.toBeFocused();
      const image = detail.locator(
        '[data-detail-main-image][tabindex="0"], [data-feed-slide-image][tabindex="0"]',
      );
      await expect(image).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      if (macWebKit) {
        // Native macOS WebKit skips implicit-tabindex buttons, also
        // without Search underneath: Shift+Tab from the explicit image target
        // goes to body. Option-Tab includes the existing Back button. Assert
        // both native paths; Linux WebKit returns directly to Back instead.
        // Do not change browser settings or force focus.
        // At the native document boundary body is activeElement without being
        // a focused control; toBeFocused() is not the corresponding assertion.
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement === document.body),
          )
          .toBe(true);
        await page.keyboard.press("Tab");
        await expect(image).toBeFocused();
        await page.keyboard.press("Alt+Shift+Tab");
      }
      await expect(back).toBeFocused();
      // Detail itself does not close on Escape. The isolated Search must not
      // consume it or close underneath the visible owner either.
      await page.keyboard.press("Escape");
      await expect(detail).toBeVisible();
      await expect(search).toHaveCount(1);
      await expect(back).toBeFocused();
      await expect.poll(() => keys.length).toBe(macWebKit ? 5 : 3);
      expect(keys).toEqual([
        { key: "Tab", trusted: true, prevented: false },
        { key: "Tab", trusted: true, prevented: false },
        ...(macWebKit
          ? [
              { key: "Tab", trusted: true, prevented: false },
              { key: "Tab", trusted: true, prevented: false },
            ]
          : []),
        { key: "Escape", trusted: true, prevented: false },
      ]);

      await back.click();
      await expect(detail).toHaveCount(0);
      await expect(input).toBeFocused();
      // The same still-open Search resumes its normal keyboard loop.
      await page.keyboard.press(shiftTabAll);
      await expect(search.locator("[data-search-submit]")).toBeFocused();
      await page.keyboard.press(shiftTabAll);
      await expect(search.locator("[data-search-close]")).toBeFocused();
      await page.keyboard.press(tabAll);
      await expect(search.locator("[data-search-submit]")).toBeFocused();
      await page.keyboard.press(tabAll);
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(search).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(pageErrors).toEqual([]);
    } finally {
      await testInfo.attach("qa-history-keyboard", {
        body: JSON.stringify({ keys, pageErrors }),
        contentType: "application/json",
      });
    }
  });
}

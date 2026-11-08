import { expect } from "@playwright/test";

import type { Locator, Page } from "@playwright/test";

/**
 * The owner's Settings entry once 我 is open. #260 moved it on a full desktop
 * window: the right rail owns one Settings button, and the embedded profile no
 * longer repeats it. Phones, tablets and compact desktop windows keep the
 * profile's own button.
 */
export const settingsEntry = async (page: Page): Promise<Locator> => {
  const profile = page.getByRole("region", { name: "用户主页" });
  await expect(profile).toBeVisible();
  const profileEntry = profile.getByRole("button", {
    name: "设置",
    exact: true,
  });
  const shell = page.locator("[data-product-shell]");
  if ((await shell.getAttribute("data-desktop")) !== "true")
    return profileEntry;
  await expect(profileEntry).toHaveCount(0);
  return shell.locator("[data-desktop-settings]");
};

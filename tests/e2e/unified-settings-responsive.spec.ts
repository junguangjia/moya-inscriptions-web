import { expect, test } from "@playwright/test";

test("complete settings keeps real guest entries and appearance on each device", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-yoyi-boot", "ready");
  const desktop =
    (await page
      .locator("[data-product-shell]")
      .getAttribute("data-desktop")) === "true";
  if (!desktop)
    await page
      .getByRole("navigation", { name: "主要内容", exact: true })
      .getByRole("button", { name: "用户", exact: true })
      .click();
  const gear = desktop
    ? page.locator("[data-desktop-settings]")
    : page
        .locator('[data-author-profile="guest"]')
        .getByRole("button", { name: "设置", exact: true });
  await gear.click();
  const root = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(root).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  for (const label of [
    "外观",
    "列表隐私",
    "已屏蔽账户",
    "账号与安全",
    "切换账号",
    "我的举报与申诉",
    "编辑信息",
    "反馈与建议",
  ])
    await expect(
      root.getByRole("button", { name: new RegExp(`^${label}`) }),
    ).toBeVisible();
  await root.getByRole("button", { name: /^外观/ }).click();
  const appearance = page.getByRole("dialog", { name: "外观", exact: true });
  await appearance
    .getByRole("radio", { name: "正常模式", exact: true })
    .click();
  await expect(page.locator("[data-product-shell]")).toHaveAttribute(
    "data-feed-layout",
    "double",
  );
  await appearance.getByRole("button", { name: "返回", exact: true }).click();
  await expect(root).toBeVisible();
  await root.getByRole("button", { name: "返回", exact: true }).click();
  await expect(root).toHaveCount(0);
  await expect(gear).toBeFocused();
});

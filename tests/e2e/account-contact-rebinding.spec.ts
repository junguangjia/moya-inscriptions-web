import { expect, test } from "@playwright/test";

// Browser-only synthetic responses. No provider delivery, real session or database.
const viewer = {
  id: "user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  handle: "synthetic-contact-settings",
  displayName: "换绑界面测试",
};
const initialAccount = {
  userId: viewer.id,
  email: {
    channel: "email",
    state: "verified",
    masked: "old***@example.com",
    version: 1,
    usable: true,
  },
  phone: {
    channel: "phone",
    state: "verified",
    masked: "138****8000",
    version: 2,
    usable: true,
  },
  capabilities: {
    profile: "full-local",
    email: { available: true, reason: null },
    phone: { available: true, reason: null },
    developmentOnly: true,
  },
};

for (const channel of ["email", "phone"] as const) {
  test(`personal settings replace ${channel} through explicit old/new verification`, async ({
    page,
  }, testInfo) => {
    let account = structuredClone(initialAccount);
    const purposes: string[] = [];
    let completed = 0;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/community/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/community/",
        "",
      );
      const body =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
      let response: unknown;
      if (path === "me") response = viewer;
      else if (path === `authors/${viewer.id}`)
        response = {
          ...viewer,
          bio: "",
          avatar: null,
          isOwner: true,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "private",
            likes: "private",
          },
          totals: {
            works: 0,
            following: 0,
            followers: 0,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        };
      else if (path === "auth/account") response = account;
      else if (path === "auth/challenges") {
        expect(body.channel).toBe(channel);
        purposes.push(body.purpose);
        response = {
          challengeId: "challenge-0123456789abcdef0123456789abcdef",
          continuationToken: "a".repeat(43),
          maskedTarget:
            body.purpose === "replace"
              ? channel === "email"
                ? "new***@example.com"
                : "139****9000"
              : account[channel].masked,
          resendAvailableAt: new Date(Date.now() + 60000).toISOString(),
        };
      } else if (path === "auth/challenges/verify")
        response = { outcome: "reauthenticated", reauthToken: "b".repeat(43) };
      else if (path === "auth/factors/complete") {
        expect(body.expectedVersion).toBe(initialAccount[channel].version);
        completed++;
        account = {
          ...account,
          [channel]: {
            ...account[channel],
            version: account[channel].version + 1,
            masked: channel === "email" ? "new***@example.com" : "139****9000",
          },
        };
        response = { account };
      } else if (path.startsWith(`authors/${viewer.id}/`))
        response = { items: [], page: 1, pageSize: 12, total: 0 };
      else {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Synthetic unrelated surface unavailable",
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 200, json: response });
    });

    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主要内容" })
      .getByRole("button", { name: "用户", exact: true })
      .click();
    const profile = page.getByRole("region", { name: "用户主页" });
    await profile.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.locator("dialog[open]");
    await settings.getByRole("button", { name: /账号与安全/ }).click();
    const label = channel === "email" ? "邮箱" : "手机号";
    await settings
      .getByRole("button", { name: `换绑${label}`, exact: true })
      .click();
    await expect(
      settings.getByRole("heading", { name: `验证原${label}`, exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: /秒后重新获取/ }),
    ).toBeDisabled();
    await settings.screenshot({
      path: testInfo.outputPath(`${channel}-old-contact.png`),
      animations: "disabled",
    });
    await settings.getByLabel("验证码", { exact: true }).fill("123456");
    await settings
      .getByRole("button", { name: "验证并继续", exact: true })
      .click();
    await settings
      .getByLabel(label, { exact: true })
      .fill(channel === "email" ? "new@example.com" : "13900139000");
    await settings
      .getByRole("button", { name: "发送验证码", exact: true })
      .click();
    await expect(
      settings.getByRole("heading", { name: `验证新${label}`, exact: true }),
    ).toBeVisible();
    await expect(settings.getByLabel("验证码", { exact: true })).toHaveValue(
      "",
    );
    await settings.screenshot({
      path: testInfo.outputPath(`${channel}-new-contact.png`),
      animations: "disabled",
    });
    expect(completed).toBe(0);
    await settings.getByLabel("验证码", { exact: true }).fill("654321");
    await settings
      .getByRole("button", { name: "确认换绑", exact: true })
      .click();
    await expect(
      settings.locator('[aria-label="登录与安全"]').getByRole("status"),
    ).toContainText(`${label}换绑成功`);
    await expect(settings).toContainText(account[channel].masked);
    expect(purposes).toEqual(["reauthenticate", "replace"]);
    expect(completed).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await settings.screenshot({
      path: testInfo.outputPath(`${channel}-success.png`),
      animations: "disabled",
    });
  });
}

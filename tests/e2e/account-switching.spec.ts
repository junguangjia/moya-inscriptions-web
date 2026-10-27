import { devices, expect, test } from "@playwright/test";
import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";

import { addSessionCookie } from "./support/session-cookie";

// account-switching-v1 (#352): browser-only synthetic responses. No Backend,
// real session, credential or database; the "sessions" below are only which
// synthetic account the fake routes treat as current or saved.
interface Account {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}
const first: Account = {
  id: `user-${"a".repeat(32)}`,
  handle: "synthetic-switch-first",
  displayName: "切换测试甲",
};
const second: Account = {
  id: `user-${"b".repeat(32)}`,
  handle: "synthetic-switch-second",
  displayName: "切换测试乙",
};
const capabilities = {
  profile: "full-local",
  email: { available: true, reason: null },
  phone: { available: false, reason: "not_configured" },
  developmentOnly: true,
};
const authorProfile = (account: Account) => ({
  ...account,
  bio: "",
  avatar: null,
  isOwner: true,
  following: false,
  privacy: {
    following: "private",
    followers: "private",
    favorites: "private",
    likes: "private",
  },
  totals: { works: 0, following: 0, followers: 0, favorites: 0, likes: 0 },
  nextAvatarChangeAt: null,
});

interface Fixture {
  current: Account | null;
  saved: Account[];
  readonly operations: string[];
  /** Saved accounts whose sign-out the fake Backend cannot confirm. */
  readonly unconfirmed?: readonly string[];
  /** Saved accounts whose session the fake Backend no longer accepts. */
  readonly refused?: readonly string[];
}

const answer = (route: Route, status: number, json?: unknown) =>
  route.fulfill(json === undefined ? { status } : { status, json });

const install = async (page: Page, fixture: Fixture) => {
  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/community/", "");
    const body =
      request.method() === "POST" ? (request.postDataJSON() as unknown) : null;
    const target = (body as { accountId?: string } | null)?.accountId;
    if (path === "me")
      return fixture.current === null
        ? answer(route, 401, {
            error: { code: "UNAUTHENTICATED", message: "Session required" },
          })
        : answer(route, 200, fixture.current);
    if (fixture.current !== null && path === `authors/${fixture.current.id}`)
      return answer(route, 200, authorProfile(fixture.current));
    if (path.startsWith("authors/"))
      return answer(route, 200, { items: [], page: 1, pageSize: 12, total: 0 });
    if (path === "accounts")
      return answer(route, 200, {
        current: fixture.current,
        others: fixture.saved.map((account) =>
          fixture.refused?.includes(account.id)
            ? {
                id: account.id,
                handle: account.handle,
                displayName: null,
                state: "reauth_required",
              }
            : { ...account, state: "ready" },
        ),
        limit: 3,
      });
    if (path === "accounts/switch") {
      const next = fixture.saved.find((account) => account.id === target);
      if (next === undefined)
        return answer(route, 404, { reason: "account_not_found" });
      fixture.saved = [
        ...(fixture.current === null ? [] : [fixture.current]),
        ...fixture.saved.filter((account) => account !== next),
      ];
      fixture.current = next;
      fixture.operations.push(`switch:${next.handle}`);
      return answer(route, 200, { current: next });
    }
    if (path === "auth/capabilities") return answer(route, 200, capabilities);
    if (path === "auth/passwords/login") {
      fixture.operations.push(
        `login:${request.headers()["x-yoyi-account-intent"] ?? "none"}`,
      );
      fixture.saved = fixture.current === null ? [] : [fixture.current];
      fixture.current = second;
      return answer(route, 200, {
        outcome: "signed_in",
        session: {
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          profile: second,
        },
      });
    }
    if (path === "auth/accounts/remove") {
      fixture.saved = fixture.saved.filter((account) => account.id !== target);
      fixture.operations.push(`remove:${target}`);
      return answer(route, 204);
    }
    if (path === "auth/accounts/sign-out-all") {
      const kept = fixture.saved.filter((account) =>
        fixture.unconfirmed?.includes(account.id),
      );
      fixture.current = null;
      fixture.saved = kept;
      fixture.operations.push("sign-out-all");
      // A partial result names what is still held and that the current
      // session ended, never a session.
      return kept.length === 0
        ? answer(route, 204)
        : answer(route, 503, {
            reason: "unavailable",
            currentCleared: true,
            remaining: kept.map(({ id, handle }) => ({ id, handle })),
          });
    }
    return answer(route, 503, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Synthetic unrelated surface unavailable",
      },
    });
  });
};

const openSettings = async (page: Page): Promise<Locator> => {
  const user = page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true });
  // Actions have no timeout here: a hidden dock must fail, not wait forever.
  await expect(user).toBeVisible();
  await user.click();
  await page
    .getByRole("region", { name: "用户主页" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  return page.locator("dialog[open]");
};
const openSwitcher = async (page: Page): Promise<Locator> => {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: /^切换账号/ }).click();
  await expect(settings.locator("[data-account-switcher]")).toBeVisible();
  return settings;
};
const expectAccounts = async (
  settings: Locator,
  current: Account,
  others: readonly Account[],
) => {
  await expect(settings.locator("[data-account-current]")).toContainText(
    current.displayName,
  );
  await expect(settings.locator("[data-account-current]")).toContainText(
    "当前",
  );
  await expect(settings.locator("[data-account-row]")).toHaveCount(
    others.length,
  );
  for (const other of others)
    await expect(
      settings.locator(`[data-account-row="${other.id}"]`),
    ).toContainText(`@${other.handle}`);
};

let phone: BrowserContext | null = null;
test.afterEach(async () => {
  await phone?.close();
  phone = null;
});

/** Sign-in is phone-only (pc-browse-only-v1): a phone page for this project. */
const phonePage = async (
  browser: Browser,
  projectPage: Page,
  testInfo: TestInfo,
): Promise<{ page: Page; baseURL: string }> => {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  if (testInfo.project.name !== "desktop-chromium") {
    await projectPage.emulateMedia({ reducedMotion: "reduce" });
    return { page: projectPage, baseURL };
  }
  phone = await browser.newContext({
    ...devices["iPhone 15"],
    baseURL,
    reducedMotion: "reduce",
  });
  return { page: await phone.newPage(), baseURL };
};

test("adds, switches, removes and signs out every account on one phone", async ({
  browser,
  page: projectPage,
}, testInfo) => {
  // Sign-in is phone-only: wide screens browse without signing in
  // (pc-browse-only-v1). Chromium emulates a phone; mobile WebKit is one.
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "Phone flow: Chromium phone emulation and mobile WebKit.",
  );
  const { page, baseURL } = await phonePage(browser, projectPage, testInfo);
  const fixture: Fixture = { current: first, saved: [], operations: [] };
  await install(page, fixture);
  await addSessionCookie(page.context(), baseURL);
  await page.goto("/");

  // 我 → 设置 → 切换账号: only the current account so far.
  let settings = await openSwitcher(page);
  await expectAccounts(settings, first, []);
  await expect(settings).toContainText("还没有添加其他账户");

  // 添加账号 signs in another account in add-account mode and comes back here.
  await settings.getByRole("button", { name: /^添加账号/ }).click();
  await expect(page).toHaveURL(/\/login\?.*intent=add-account/u);
  await expect(page.getByRole("heading", { name: "添加账号" })).toBeVisible();
  await page.getByLabel("邮箱地址").fill("second@example.com");
  await page.getByLabel("密码", { exact: true }).fill("A1合成测试密码");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  settings = page.locator("dialog[open]");
  await expect(settings.locator("[data-account-switcher]")).toBeVisible();
  await expectAccounts(settings, second, [first]);
  expect(fixture.operations).toEqual(["login:add"]);

  // Switching reloads the whole page as the other account.
  let reload = page.waitForEvent("load");
  await settings
    .getByRole("button", { name: `切换到「${first.displayName}」` })
    .click();
  await reload;
  settings = await openSwitcher(page);
  await expectAccounts(settings, first, [second]);

  // And back again.
  reload = page.waitForEvent("load");
  await settings
    .getByRole("button", { name: `切换到「${second.displayName}」` })
    .click();
  await reload;
  settings = await openSwitcher(page);
  await expectAccounts(settings, second, [first]);

  // 移除 asks first, then signs that account out on this browser.
  await settings
    .getByRole("button", { name: `移除「${first.displayName}」` })
    .click();
  const removal = settings.getByRole("alertdialog");
  await expect(removal).toContainText("其他设备不受影响");
  await removal.getByRole("button", { name: "移除", exact: true }).click();
  await expect(settings.locator("[data-account-row]")).toHaveCount(0);
  await expect(settings).toContainText(`已移除「${first.displayName}」`);

  // 退出所有账号 asks first and leaves this browser signed out.
  await settings
    .getByRole("button", { name: "退出所有账号", exact: true })
    .click();
  reload = page.waitForEvent("load");
  await settings
    .getByRole("alertdialog")
    .getByRole("button", { name: "退出所有账号", exact: true })
    .click();
  await reload;
  settings = await openSettings(page);
  await expect(settings).toContainText("登录后管理账户设置");
  await expect(settings.getByRole("button", { name: /^切换账号/ })).toHaveCount(
    0,
  );
  expect(fixture.operations).toEqual([
    "login:add",
    `switch:${first.handle}`,
    `switch:${second.handle}`,
    `remove:${first.id}`,
    "sign-out-all",
  ]);
});

test("a partial 退出所有账号 reloads signed out and names the account still held", async ({
  browser,
  page: projectPage,
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "Phone flow: Chromium phone emulation and mobile WebKit.",
  );
  const { page, baseURL } = await phonePage(browser, projectPage, testInfo);
  const fixture: Fixture = {
    current: first,
    saved: [second],
    operations: [],
    unconfirmed: [second.id],
  };
  await install(page, fixture);
  await addSessionCookie(page.context(), baseURL);
  await page.goto("/");

  let settings = await openSwitcher(page);
  await expectAccounts(settings, first, [second]);
  await settings
    .getByRole("button", { name: "退出所有账号", exact: true })
    .click();
  const reload = page.waitForEvent("load");
  await settings
    .getByRole("alertdialog")
    .getByRole("button", { name: "退出所有账号", exact: true })
    .click();
  await reload;

  // The reloaded page is signed out and says what is left, never a plain
  // success.
  const feedback = page.locator(".phase4-feedback");
  await expect(feedback).toContainText(
    `已退出当前账号；另有 1 个账号未能确认退出：「${second.displayName}」`,
  );
  await expect(feedback.getByRole("button")).toHaveCount(0);
  settings = await openSettings(page);
  await expect(settings).toContainText("登录后管理账户设置");
  await settings.getByRole("button", { name: /^切换账号/ }).click();
  await expect(settings.locator("[data-account-switcher]")).toBeVisible();
  await expect(settings.locator("[data-account-current]")).toHaveCount(0);
  await expect(settings).toContainText("未登录");
  await expect(
    settings.locator(`[data-account-row="${second.id}"]`),
  ).toContainText(`@${second.handle}`);
  expect(fixture.operations).toEqual(["sign-out-all"]);

  // The notice is shown once: the next load does not repeat it.
  await page.reload();
  settings = await openSettings(page);
  await expect(settings).toContainText("登录后管理账户设置");
  await expect(feedback).not.toContainText("已退出当前账号");
});

test("a 需重新登录 account stays listed on every read and 移除 lets it go", async ({
  browser,
  page: projectPage,
}, testInfo) => {
  test.skip(
    !["desktop-chromium", "mobile-webkit"].includes(testInfo.project.name),
    "Phone flow: Chromium phone emulation and mobile WebKit.",
  );
  const { page, baseURL } = await phonePage(browser, projectPage, testInfo);
  const fixture: Fixture = {
    current: first,
    saved: [second],
    operations: [],
    refused: [second.id],
  };
  await install(page, fixture);
  await addSessionCookie(page.context(), baseURL);
  await page.goto("/");

  const expired = `[data-account-row="${second.id}"]`;
  let settings = await openSwitcher(page);
  for (let read = 0; read < 2; read++) {
    await expect(settings.locator(expired)).toHaveAttribute(
      "data-account-state",
      "reauth_required",
    );
    await expect(settings.locator(expired)).toContainText("需重新登录");
    await expect(
      settings.locator(expired).getByRole("button", { name: /^重新登录/ }),
    ).toBeVisible();
    await expect(settings).toContainText("不再使用时可以移除");
    // Reading again (a new page) still lists it.
    if (read === 0) {
      await page.reload();
      settings = await openSwitcher(page);
    }
  }
  await settings
    .getByRole("button", { name: `移除「@${second.handle}」` })
    .click();
  const removal = settings.getByRole("alertdialog");
  await expect(removal).toContainText("其他设备不受影响");
  await removal.getByRole("button", { name: "移除", exact: true }).click();
  await expect(settings.locator("[data-account-row]")).toHaveCount(0);
  await expect(settings).toContainText(`已移除「@${second.handle}」`);
  expect(fixture.operations).toEqual([`remove:${second.id}`]);
});

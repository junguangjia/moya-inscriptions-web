import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { addSessionCookie } from "./support/session-cookie";

// account-deletion-v1. Browser-only synthetic responses: no provider
// delivery, real Session, account or database is used.
const viewer = {
  id: `user-${"d".repeat(32)}`,
  handle: "synthetic-account-deletion",
  displayName: "注销流程测试",
};
const other = `user-${"e".repeat(32)}`;
const account = {
  userId: viewer.id,
  email: {
    channel: "email",
    state: "unbound",
    masked: null,
    version: 0,
    usable: false,
  },
  phone: {
    channel: "phone",
    state: "verified",
    masked: "138****8000",
    version: 1,
    usable: true,
  },
  capabilities: {
    profile: "full-local",
    email: { available: true, reason: null },
    phone: { available: true, reason: null },
    developmentOnly: true,
  },
};
// A one-pixel PNG: a pending avatar intent the page cannot save here.
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Per-account data this browser keeps for the viewer and for another account. */
const seedLocalData = (page: Page) =>
  page.evaluate(
    async ({ viewerId, otherId }) => {
      const open = (name: string, stores: string[]) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => {
            for (const store of stores)
              if (!request.result.objectStoreNames.contains(store))
                request.result.createObjectStore(store);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const put = async (
        name: string,
        stores: string[],
        writes: [string, IDBValidKey, unknown][],
      ) => {
        const database = await open(name, stores);
        const transaction = database.transaction(stores, "readwrite");
        for (const [store, key, value] of writes)
          transaction.objectStore(store).put(value, key);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      };
      for (const id of [viewerId, otherId]) {
        localStorage.setItem(
          `artvenn.phase4.history.${id}.v1`,
          JSON.stringify([{ type: "catalog", id: "catalog-one" }]),
        );
        localStorage.setItem(`artvenn.editor.interruption.${id}`, "{}");
        sessionStorage.setItem(`artvenn.editor.interruption.${id}`, "{}");
      }
      const draft = `work-draft-${"c".repeat(32)}`;
      await put(
        "artvenn.publishing.recovery.v1",
        ["items", "sizes"],
        [viewerId, otherId].flatMap((id): [string, IDBValidKey, unknown][] => [
          [
            "items",
            [id, draft, "k1"],
            { accountId: id, draftId: draft, itemKey: "k1" },
          ],
          ["sizes", [id, draft, "k1"], 1],
        ]),
      );
      await put(
        "artvenn.publishing.editor.v1",
        ["sessions"],
        [viewerId, otherId].map((id): [string, IDBValidKey, unknown] => [
          "sessions",
          `edit-${id}`,
          { accountId: id, id: `edit-${id}` },
        ]),
      );
      await put(
        "artvenn.phase4.local.v1",
        ["guest"],
        [
          [
            "guest",
            "state",
            {
              items: [],
              batches: [viewerId, otherId].map((id) => ({
                accountId: id,
                requestId: crypto.randomUUID(),
                entries: [],
              })),
            },
          ],
        ],
      );
    },
    { viewerId: viewer.id, otherId: other },
  );

/** Which accounts still have data in each of those stores. */
const readLocalData = (page: Page) =>
  page.evaluate(async () => {
    const read = (name: string, store: string) =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onsuccess = () => {
          const values = request.result
            .transaction(store)
            .objectStore(store)
            .getAll();
          values.onsuccess = () => {
            request.result.close();
            resolve(values.result);
          };
          values.onerror = () => reject(values.error);
        };
        request.onerror = () => reject(request.error);
      });
    const owners = (values: unknown[]) =>
      values.map((value) => (value as { accountId?: string }).accountId).sort();
    const keys = (prefix: string) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .sort();
    const guest = (await read("artvenn.phase4.local.v1", "guest"))[0] as {
      batches: { accountId: string }[];
    };
    return {
      avatar: keys("yoyi-avatar-save-v1:"),
      history: keys("artvenn.phase4.history."),
      interruption: keys("artvenn.editor.interruption."),
      session: Object.keys(sessionStorage)
        .filter((key) => key.startsWith("artvenn.editor.interruption."))
        .sort(),
      recovery: owners(await read("artvenn.publishing.recovery.v1", "items")),
      editor: owners(await read("artvenn.publishing.editor.v1", "sessions")),
      merges: owners(guest.batches),
    };
  });

test("personal settings delete the account after re-verification and clear this browser's data", async ({
  page,
}, testInfo) => {
  let deletedAt: string | null = null;
  const deletions: { account: string | null; body: unknown }[] = [];
  const order: string[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    // Records the deletion ping as other tabs would see it; the key itself is
    // removed right after it is written.
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "yoyi-account-deleted")
        sessionStorage.setItem("synthetic-deletion-ping", value);
      setItem.call(this, key, value);
    };
  });
  await page.addInitScript(
    ({ id, image }) => {
      if (sessionStorage.getItem("synthetic-avatar-seeded")) return;
      sessionStorage.setItem("synthetic-avatar-seeded", "1");
      localStorage.setItem(
        `yoyi-avatar-save-v1:${id}`,
        JSON.stringify({
          accountId: id,
          uploadId: crypto.randomUUID(),
          saveId: crypto.randomUUID(),
          png: image,
        }),
      );
    },
    { id: viewer.id, image: png },
  );
  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/community/", "");
    // The pending avatar's own upload is a PNG body, not JSON.
    const body =
      request.method() === "POST" &&
      request.headers()["content-type"] === "application/json"
        ? request.postDataJSON()
        : null;
    if (path.startsWith("auth/")) order.push(path);
    // After deletion every request is answered as for a refused Session.
    if (deletedAt !== null && (path === "me" || path === "auth/account")) {
      await route.fulfill({
        status: 401,
        json: {
          error: { code: "UNAUTHENTICATED", message: "AUTH_UNAUTHENTICATED" },
        },
      });
      return;
    }
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
          following: "private",
          followers: "private",
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
      expect(body).toMatchObject({
        channel: "phone",
        purpose: "reauthenticate",
      });
      response = {
        challengeId: "challenge-0123456789abcdef0123456789abcdef",
        continuationToken: "a".repeat(43),
        maskedTarget: "138****8000",
        resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
      };
    } else if (path === "auth/challenges/verify")
      response = { outcome: "reauthenticated", reauthToken: "b".repeat(43) };
    else if (path === "auth/account/deletion") {
      deletions.push({
        account: request.headers()["x-author-account"] ?? null,
        body,
      });
      deletedAt = "2026-10-27T01:00:00.000Z";
      // The Web relay clears the Session cookies on this answer (unit-tested).
      await page.context().clearCookies({ name: "yoyi-session" });
      response = { outcome: "deleted", deletedAt };
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

  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  await addSessionCookie(page.context(), baseURL);
  await page.goto("/");
  const user = page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true });
  // Actions have no timeout here: a hidden dock must fail, not wait forever.
  await expect(user).toBeVisible();
  await seedLocalData(page);
  expect(await readLocalData(page)).toEqual({
    avatar: [`yoyi-avatar-save-v1:${viewer.id}`],
    history: [
      `artvenn.phase4.history.${viewer.id}.v1`,
      `artvenn.phase4.history.${other}.v1`,
    ],
    interruption: [
      `artvenn.editor.interruption.${viewer.id}`,
      `artvenn.editor.interruption.${other}`,
    ],
    session: [
      `artvenn.editor.interruption.${viewer.id}`,
      `artvenn.editor.interruption.${other}`,
    ],
    recovery: [viewer.id, other],
    editor: [viewer.id, other],
    merges: [viewer.id, other],
  });

  await user.click();
  const profile = page.getByRole("region", { name: "用户主页" });
  await expect(
    profile.getByRole("button", { name: "设置", exact: true }),
  ).toBeVisible();
  await profile.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.locator("dialog[open]");
  await expect(
    settings.getByRole("button", { name: /账号与安全/ }),
  ).toBeVisible();
  await settings.getByRole("button", { name: /账号与安全/ }).click();
  await expect(
    settings.getByRole("button", { name: /注销账号/ }),
  ).toBeVisible();
  // Signed-in settings wait for the account read before sign-out is offered.
  await expect(
    settings.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeEnabled();
  await settings.screenshot({
    path: testInfo.outputPath("security-entry.png"),
    animations: "disabled",
  });
  await settings.getByRole("button", { name: /注销账号/ }).click();
  const deletion = settings.getByRole("region", { name: "注销账号" });
  await expect(deletion).toContainText("账号立即注销，不能撤销，也不能恢复。");
  await expect(deletion).toContainText("已使用的邀请名额不退还");
  await settings.screenshot({
    path: testInfo.outputPath("deletion-effects.png"),
    animations: "disabled",
  });
  await expect(
    deletion.getByRole("button", { name: "继续", exact: true }),
  ).toBeEnabled();
  await deletion.getByRole("button", { name: "继续", exact: true }).click();
  await expect(deletion).toContainText("新头像还没有保存完成。");
  await deletion.getByRole("button", { name: "仍然继续", exact: true }).click();
  const send = deletion.getByRole("button", {
    name: /发送验证码到手机号 138\*\*\*\*8000/u,
  });
  await expect(send).toBeDisabled();
  await deletion.getByLabel("我已了解注销后无法恢复").check();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    deletion.getByRole("heading", { name: "验证手机号", exact: true }),
  ).toBeVisible();
  await deletion.getByLabel("验证码", { exact: true }).fill("123456");
  await deletion.getByRole("button", { name: "验证", exact: true }).click();
  await expect(
    deletion.getByRole("heading", { name: "确认注销", exact: true }),
  ).toBeVisible();
  expect(deletions).toEqual([]);
  await settings.screenshot({
    path: testInfo.outputPath("deletion-confirm.png"),
    animations: "disabled",
  });
  await deletion.getByRole("button", { name: "确认注销", exact: true }).click();
  await expect(
    deletion.getByRole("heading", { name: "账号已注销", exact: true }),
  ).toBeVisible();
  expect(deletions).toEqual([
    {
      account: viewer.id,
      body: {
        reauthToken: "b".repeat(43),
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      },
    },
  ]);
  expect(order.filter((path) => path !== "auth/account")).toEqual([
    "auth/challenges",
    "auth/challenges/verify",
    "auth/account/deletion",
  ]);
  // Only the deleted account's data leaves this browser.
  await expect
    .poll(() => readLocalData(page))
    .toEqual({
      avatar: [],
      history: [`artvenn.phase4.history.${other}.v1`],
      interruption: [`artvenn.editor.interruption.${other}`],
      session: [`artvenn.editor.interruption.${other}`],
      recovery: [other],
      editor: [other],
      merges: [other],
    });
  // Other tabs of this browser learn which account was deleted (its opaque
  // id and the time), end its editing and clear its data there too.
  await expect
    .poll(async () =>
      JSON.parse(
        (await page.evaluate(() =>
          sessionStorage.getItem("synthetic-deletion-ping"),
        )) ?? "null",
      ),
    )
    .toEqual({ accountId: viewer.id, at: expect.any(String) });
  // ...and this browser keeps no record of the deleted account.
  expect(
    await page.evaluate(() => localStorage.getItem("yoyi-account-deleted")),
  ).toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await settings.screenshot({
    path: testInfo.outputPath("deletion-done.png"),
    animations: "disabled",
  });
  await deletion.getByRole("button", { name: "完成", exact: true }).click();
  // The product reloads at its root as a signed-out visitor.
  await page.waitForURL((url) => url.pathname === "/" && url.hash === "");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === "yoyi-session",
    ),
  ).toBe(false);
  // Phone layout (Production's only signed-in surface): 我 offers 登录 again.
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await expect(user).toBeVisible();
    await user.click();
    await expect(
      page
        .getByRole("region", { name: "用户主页" })
        .getByRole("link", { name: "登录", exact: true }),
    ).toBeVisible();
  }
});

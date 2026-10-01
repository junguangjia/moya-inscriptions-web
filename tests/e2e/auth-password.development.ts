import type { APIRequestContext, APIResponse } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Dedicated Development acceptance. Codes, passwords, proofs and cookies are
// held only in memory; assertions report booleans rather than credential values.
const profile = process.env.AUTH_UI_PROFILE ?? "full-local";
const capture = new URL(
  process.env.AUTH_UI_MAILPIT_URL ?? "http://127.0.0.1:3553",
);
if (
  capture.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(capture.hostname) ||
  capture.username ||
  capture.password
)
  throw new Error("Password acceptance requires local Development capture");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const post = (page: Page, path: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/community/auth/${path}`,
  );
const secretFill = async (page: Page, label: string, value: string) => {
  try {
    await page.getByLabel(label, { exact: true }).fill(value);
  } catch {
    throw new Error("Credential field could not be filled");
  }
};
const capturedCode = async (email: string, excluded = new Set<string>()) => {
  let result: { id: string; code: string } | undefined;
  await expect
    .poll(
      async () => {
        const inboxUrl = new URL("/api/v1/search", capture);
        inboxUrl.searchParams.set("query", `to:"${email}"`);
        inboxUrl.searchParams.set("limit", "100");
        const response = await fetch(inboxUrl);
        if (!response.ok) return false;
        const messages = record(await response.json()).messages;
        if (!Array.isArray(messages)) return false;
        for (const item of messages) {
          const message = record(item);
          if (
            typeof message.ID !== "string" ||
            excluded.has(message.ID) ||
            !Array.isArray(message.To) ||
            !message.To.some((to) => record(to).Address === email)
          )
            continue;
          const detail = await fetch(
            new URL(
              `/api/v1/message/${encodeURIComponent(message.ID)}`,
              capture,
            ),
          );
          if (!detail.ok) continue;
          const text = record(await detail.json()).Text;
          const code =
            typeof text === "string"
              ? /验证码[：:]\s*(\d{6})/u.exec(text)?.[1]
              : undefined;
          if (code) {
            result = { id: message.ID, code };
            return true;
          }
        }
        return false;
      },
      {
        timeout: 15000,
        message: "Expected a local captured verification message",
      },
    )
    .toBe(true);
  if (!result) throw new Error("Local verification message unavailable");
  return result;
};

for (const channel of ["email", "phone"] as const) {
  test(`${channel}: register password, sign in, reset without session resurrection`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      channel === "phone" &&
        (profile !== "full-local" ||
          testInfo.project.name !== "desktop-chromium"),
      "One simulated phone journey preserves server send limits",
    );
    const identifier =
      channel === "email"
        ? `password-${randomBytes(8).toString("hex")}@example.invalid`
        : `139${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`;
    const oldPassword = `A${randomBytes(6).toString("hex")}9`;
    const newPassword = `B${randomBytes(6).toString("hex")}7`;
    const destination = "/dev/community";
    let registrationCount = 0,
      avatarWrites = 0,
      contentWrites = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/auth/registrations")) registrationCount++;
      if (
        pathname.endsWith("/me/avatar") ||
        pathname.endsWith("/community/media")
      )
        avatarWrites++;
      if (/\/(?:comments|follow|works)(?:\/|$)/u.test(pathname))
        contentWrites++;
    });
    const response = await privateRequest(page.request).get(
      "/api/community/auth/capabilities",
    );
    expect(response.status()).toBe(200);
    expect(record(await response.json()).profile).toBe(profile);
    await page.goto(`/register?return=${encodeURIComponent(destination)}`);
    await expect(page.getByText("由于艺", { exact: true })).toBeVisible();
    if (channel === "phone")
      await page.getByRole("button", { name: /^手机$/ }).click();
    await page
      .getByLabel(channel === "email" ? /^邮箱(?:地址)?$/ : /^手机号$/)
      .fill(identifier);
    const sending = post(page, "challenges");
    await page.getByRole("button", { name: "发送验证码", exact: true }).click();
    expect((await sending).status()).toBe(200);
    const first =
      channel === "email"
        ? await capturedCode(identifier)
        : await capturedPhoneCode(`+86${identifier}`);
    const verify = post(page, "challenges/verify");
    try {
      await page
        .locator('input[autocomplete="one-time-code"]')
        .fill(first.code);
    } catch {
      throw new Error("Verification input could not be filled");
    }
    await page.locator('form button[type="submit"]').click();
    expect((await verify).status()).toBe(200);
    await secretFill(page, "密码", oldPassword);
    await secretFill(page, "确认密码", oldPassword);
    await page.locator('form button[type="submit"]').click();
    await page.getByLabel("昵称", { exact: true }).fill("密码预览访客");
    await page.getByLabel("名称", { exact: true }).fill("听雨");
    await expect(
      page.getByRole("combobox", { name: "称谓", exact: true }),
    ).toHaveValue("斋");
    await page.getByRole("checkbox").check();
    const creation = post(page, "registrations");
    await page.getByRole("button", { name: "创建账户", exact: true }).click();
    expect((await creation).status()).toBe(201);
    await page.getByRole("button", { name: /跳过/ }).click();
    await expect(page).toHaveURL(/\/dev\/community$/);
    expect(registrationCount).toBe(1);
    expect(avatarWrites).toBe(0);
    const me = await privateRequest(page.request).get("/api/community/me");
    expect(me.status()).toBe(200);
    const user = record(await me.json());
    const userProfile = await privateRequest(page.request).get(
      `/api/community/authors/${encodeURIComponent(String(user.id))}`,
    );
    expect(userProfile.status()).toBe(200);
    expect(record(await userProfile.json()).studioName === "听雨斋").toBe(true);
    const originalCookies = await context.cookies();
    expect(
      originalCookies.some(
        (cookie) => cookie.name === "yoyi-session" && cookie.httpOnly,
      ),
    ).toBe(true);
    expect(
      (
        await privateRequest(page.request).post("/api/community/auth/sign-out")
      ).ok(),
    ).toBe(true);

    await page.goto(`/login?return=${encodeURIComponent(destination)}`);
    if (channel === "phone")
      await page.getByRole("button", { name: /^手机$/ }).click();
    await page
      .getByLabel(channel === "email" ? /^邮箱(?:地址)?$/ : /^手机号$/)
      .fill(identifier);
    await secretFill(page, "密码", oldPassword);
    const login = post(page, "passwords/login");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    expect((await login).status()).toBe(200);
    await expect(page).toHaveURL(/\/dev\/community$/);
    const beforeResetCookies = await context.cookies();

    await page.goto(`/login?return=${encodeURIComponent(destination)}`);
    await page.getByRole("button", { name: "忘记密码", exact: true }).click();
    if (channel === "phone")
      await page.getByRole("button", { name: /^手机$/ }).click();
    await page
      .getByLabel(channel === "email" ? /^邮箱(?:地址)?$/ : /^手机号$/)
      .fill(identifier);
    const resetSending = post(page, "challenges");
    await page.getByRole("button", { name: "发送验证码", exact: true }).click();
    expect((await resetSending).status()).toBe(200);
    const second =
      channel === "email"
        ? await capturedCode(identifier, new Set([first.id]))
        : await capturedPhoneCode(`+86${identifier}`, new Set([first.id]));
    try {
      await page
        .locator('input[autocomplete="one-time-code"]')
        .fill(second.code);
    } catch {
      throw new Error("Verification input could not be filled");
    }
    const resetVerify = post(page, "challenges/verify");
    await page.locator('form button[type="submit"]').click();
    const verified = await resetVerify;
    expect(verified.status()).toBe(200);
    const proof = record(await verified.json()).handoffToken;
    expect(typeof proof === "string").toBe(true);
    await secretFill(page, "新密码", newPassword);
    await secretFill(page, "确认新密码", newPassword);
    const resetting = post(page, "passwords/reset");
    await page.locator('form button[type="submit"]').click();
    const reset = await resetting;
    expect(reset.status()).toBe(200);
    expect(record(await reset.json()).reset === true).toBe(true);
    // Check before /me can independently recover a refused old Cookie.
    expect(
      (await context.cookies()).some(
        (cookie) => cookie.name === "yoyi-session",
      ),
    ).toBe(false);
    expect(
      (await privateRequest(page.request).get("/api/community/me")).status(),
    ).toBe(401);
    const stale = await context.browser()?.newContext();
    if (!stale) throw new Error("Browser context unavailable");
    await stale.addCookies(beforeResetCookies);
    expect(
      (
        await privateRequest(stale.request).get(
          new URL("/api/community/me", page.url()).href,
        )
      ).status(),
    ).toBe(401);
    await stale.close();
    expect(
      (
        await privateRequest(page.request).post(
          "/api/community/auth/passwords/reset",
          {
            data: {
              handoffToken: proof,
              password: newPassword,
              idempotencyKey: crypto.randomUUID(),
            },
          },
        )
      ).status(),
    ).not.toBe(200);
    await page.getByRole("button", { name: /(?:去登录|返回登录)/ }).click();
    if (channel === "email" && testInfo.project.name === "desktop-chromium") {
      // Same mounted flow: the reset relay must clear its revoked Cookie so
      // switching directly to OTP can send and verify without a /me recovery.
      expect(
        (await context.cookies()).some(
          (cookie) => cookie.name === "yoyi-session",
        ),
      ).toBe(false);
      await page
        .getByRole("button", { name: "验证码登录", exact: true })
        .click();
      await page.getByLabel(/^邮箱(?:地址)?$/).fill(identifier);
      const otpSending = post(page, "challenges");
      await page
        .getByRole("button", { name: "发送验证码", exact: true })
        .click();
      expect((await otpSending).status()).toBe(200);
      const third = await capturedCode(
        identifier,
        new Set([first.id, second.id]),
      );
      try {
        await page
          .locator('input[autocomplete="one-time-code"]')
          .fill(third.code);
      } catch {
        throw new Error("Verification input could not be filled");
      }
      const otpVerify = post(page, "challenges/verify");
      await page.locator('form button[type="submit"]').click();
      expect((await otpVerify).status()).toBe(200);
      await expect(page).toHaveURL(/\/dev\/community$/);
      expect(
        (
          await privateRequest(page.request).post(
            "/api/community/auth/sign-out",
          )
        ).ok(),
      ).toBe(true);
      await page.goto(`/login?return=${encodeURIComponent(destination)}`);
    }
    await page
      .getByLabel(channel === "email" ? /^邮箱(?:地址)?$/ : /^手机号$/)
      .fill(identifier);
    // One real rejection probe is sufficient; keep the existing shared
    // 20-attempt source window intact across all three browser journeys.
    if (channel === "email" && testInfo.project.name === "desktop-chromium") {
      await secretFill(page, "密码", oldPassword);
      const denied = post(page, "passwords/login");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      expect((await denied).status()).toBe(401);
    }
    await secretFill(page, "密码", newPassword);
    const accepted = post(page, "passwords/login");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    expect((await accepted).status()).toBe(200);
    await expect(page).toHaveURL(/\/dev\/community$/);
    expect(
      (await privateRequest(page.request).get("/api/community/me")).status(),
    ).toBe(200);
    expect(registrationCount).toBe(1);
    expect(avatarWrites).toBe(0);
    expect(contentWrites).toBe(0);
  });
}

async function capturedPhoneCode(target: string, excluded = new Set<string>()) {
  let result: { id: string; code: string } | undefined;
  await expect
    .poll(
      async () => {
        const inboxUrl = new URL("/api/v1/search", capture);
        inboxUrl.searchParams.set("query", `"${target}"`);
        inboxUrl.searchParams.set("limit", "100");
        const response = await fetch(inboxUrl);
        if (!response.ok) return false;
        const messages = record(await response.json()).messages;
        if (!Array.isArray(messages)) return false;
        for (const item of messages) {
          const message = record(item);
          if (
            message.Subject !== "SIMULATED SMS — NOT SENT" ||
            typeof message.ID !== "string" ||
            excluded.has(message.ID)
          )
            continue;
          const detail = await fetch(
            new URL(
              `/api/v1/message/${encodeURIComponent(message.ID)}`,
              capture,
            ),
          );
          const text = record(await detail.json()).Text;
          const code =
            typeof text === "string" && text.includes(`To: ${target}`)
              ? /验证码[：:]\s*(\d{6})/u.exec(text)?.[1]
              : undefined;
          if (code) {
            result = { id: message.ID, code };
            return true;
          }
        }
        return false;
      },
      {
        timeout: 15000,
        message: "Expected a local simulated phone verification message",
      },
    )
    .toBe(true);
  if (!result) throw new Error("Local phone verification message unavailable");
  return result;
}

test("registered owner explicitly crops and saves an avatar", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "One real existing avatar upload journey per isolated profile",
  );
  const email = `avatar-${randomBytes(8).toString("hex")}@example.invalid`;
  const password = `A${randomBytes(6).toString("hex")}9`;
  let registrations = 0,
    uploads = 0,
    avatarSaves = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/auth/registrations")) registrations++;
    if (path.endsWith("/community/media")) uploads++;
    if (path.endsWith("/me/avatar")) avatarSaves++;
  });
  await page.goto("/register?return=%2Fdev%2Fcommunity");
  await page.getByLabel(/^邮箱(?:地址)?$/).fill(email);
  const sending = post(page, "challenges");
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  expect((await sending).status()).toBe(200);
  const captured = await capturedCode(email);
  try {
    await page
      .locator('input[autocomplete="one-time-code"]')
      .fill(captured.code);
  } catch {
    throw new Error("Verification input could not be filled");
  }
  const verifying = post(page, "challenges/verify");
  await page.locator('form button[type="submit"]').click();
  expect((await verifying).status()).toBe(200);
  await secretFill(page, "密码", password);
  await secretFill(page, "确认密码", password);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByLabel("昵称", { exact: true }).fill("头像预览访客");
  await page.getByRole("checkbox").check();
  const creating = post(page, "registrations");
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  expect((await creating).status()).toBe(201);
  await expect(
    page.getByRole("heading", { name: "设置头像", exact: true }),
  ).toBeVisible();
  const syntheticPng = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image fixture unavailable");
    context.fillStyle = "#B34A32";
    context.fillRect(0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  await page.getByLabel("选择头像照片", { exact: true }).setInputFiles({
    name: "synthetic-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(syntheticPng, "base64"),
  });
  const save = page.getByRole("button", { name: "保存头像", exact: true });
  await expect(save).toBeEnabled();
  expect(uploads).toBe(0);
  expect(avatarSaves).toBe(0);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/me/avatar"),
  );
  await save.click();
  expect((await saved).status()).toBe(200);
  expect(uploads).toBe(1);
  expect(avatarSaves).toBe(1);
  expect(registrations).toBe(1);
  const me = record(
    await (await privateRequest(page.request).get("/api/community/me")).json(),
  );
  const author = await privateRequest(page.request).get(
    `/api/community/authors/${encodeURIComponent(String(me.id))}`,
  );
  expect(author.status()).toBe(200);
  const avatar = record(record(await author.json()).avatar);
  expect(
    typeof avatar.src === "string" &&
      avatar.width === 512 &&
      avatar.height === 512,
  ).toBe(true);
  const complete = page.getByRole("button", { name: "完成", exact: true });
  await expect(complete).toBeVisible();
  await complete.click();
  await expect(page).toHaveURL(/\/dev\/community$/);
  expect(uploads).toBe(1);
  expect(avatarSaves).toBe(1);
  expect(registrations).toBe(1);
});

// Never forward Playwright API call logs containing private Cookie/body data.
const privateRequest = (api: APIRequestContext) => ({
  get: async (
    ...args: Parameters<APIRequestContext["get"]>
  ): Promise<APIResponse> => {
    try {
      return await api.get(...args);
    } catch {
      throw new Error("Development API read unavailable");
    }
  },
  post: async (
    ...args: Parameters<APIRequestContext["post"]>
  ): Promise<APIResponse> => {
    try {
      return await api.post(...args);
    } catch {
      throw new Error("Development API write result unavailable");
    }
  },
});

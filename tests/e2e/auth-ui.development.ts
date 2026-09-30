import { randomBytes } from "node:crypto";
import {
  expect,
  test,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";

const profile = process.env.AUTH_UI_PROFILE ?? "full-local";
const acceptanceCatalogId = process.env.AUTH_UI_CATALOG_ID;
if (
  acceptanceCatalogId &&
  !/^catalog-auth-ui-167-synthetic(?:-[a-z0-9]+)?$/u.test(acceptanceCatalogId)
)
  throw new Error(
    "AUTH_UI_CATALOG_ID must identify this task's synthetic fixture",
  );
const captureOrigin = new URL(
  process.env.AUTH_UI_MAILPIT_URL ?? "http://127.0.0.1:3553",
);
if (
  captureOrigin.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(captureOrigin.hostname) ||
  captureOrigin.username ||
  captureOrigin.password ||
  captureOrigin.search ||
  captureOrigin.hash
)
  throw new Error("Mailpit acceptance capture must use loopback");

type Capture = { id: string; code: string };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const uniqueEmail = () =>
  `auth-ui-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}@example.invalid`;
const codeField = (page: Page) =>
  page.locator('input[autocomplete="one-time-code"]');
const emailField = (page: Page) => page.getByLabel(/^邮箱(?:地址)?$/);
const phoneField = (page: Page) => page.getByLabel(/^手机(?:号码|号)$/);
const nicknameField = (page: Page) => page.getByLabel(/^昵称$/);
const submit = (page: Page) => page.locator('form button[type="submit"]');
const modeLink = (page: Page, mode: "login" | "register") =>
  page
    .getByRole("link", { name: mode === "login" ? /去登录/ : /去注册/ })
    .or(
      page.getByRole("button", {
        name: mode === "login" ? /去登录/ : /去注册/,
      }),
    )
    .first();
const authResponse = (page: Page, suffix: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/community/auth/${suffix}`,
  );
const parsed = async (response: Response) => {
  try {
    return record(await response.json());
  } catch {
    throw new Error("Auth API response was not valid JSON");
  }
};

// All capture bodies, one-time codes, challenge continuations and HttpOnly cookies
// stay in memory. Do not assert entire bodies or token/code values: assertion
// diffs and Playwright traces could otherwise publish credential material.
async function latestCapture(
  target: string,
  excluded = new Set<string>(),
  phone = false,
): Promise<Capture> {
  let found: Capture | undefined;
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(
            new URL("/api/v1/messages?limit=100", captureOrigin),
          );
          if (!response.ok) return false;
          const inbox = record(await response.json());
          const messages = Array.isArray(inbox.messages) ? inbox.messages : [];
          for (const item of messages) {
            const message = record(item);
            const id = typeof message.ID === "string" ? message.ID : "";
            if (!id || excluded.has(id)) continue;
            const recipients = Array.isArray(message.To) ? message.To : [];
            const isTarget = recipients.some(
              (recipient) => record(recipient).Address === target,
            );
            if (!phone && !isTarget) continue;
            if (phone && message.Subject !== "SIMULATED SMS — NOT SENT")
              continue;
            const detailResponse = await fetch(
              new URL(
                `/api/v1/message/${encodeURIComponent(id)}`,
                captureOrigin,
              ),
            );
            if (!detailResponse.ok) continue;
            const detail = record(await detailResponse.json());
            const text = typeof detail.Text === "string" ? detail.Text : "";
            if (phone && !text.includes(`To: ${target}`)) continue;
            const code = /验证码[：:]\s*(\d{6})/u.exec(text)?.[1];
            if (code) {
              found = { id, code };
              return true;
            }
          }
          return false;
        } catch {
          return false;
        }
      },
      {
        message: "Expected a task-local captured verification message",
        timeout: 15_000,
      },
    )
    .toBe(true);
  if (!found) throw new Error("Task-local captured message was unavailable");
  return found;
}

async function emptyCodeScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  const input = codeField(page);
  const safe = (await input.count()) === 0 || (await input.inputValue()) === "";
  expect(safe, "Screenshots require an empty verification input").toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

async function goAuth(
  page: Page,
  mode: "login" | "register",
  returnTo: string,
) {
  await page.goto(`/${mode}?return=${encodeURIComponent(returnTo)}`);
  await expect(emailField(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^发送验证码$/ }),
  ).toBeEnabled();
}

async function send(
  page: Page,
  identifier: string,
  channel: "email" | "phone" = "email",
) {
  await (channel === "email" ? emailField(page) : phoneField(page)).fill(
    identifier,
  );
  const waiting = authResponse(page, "challenges");
  await page.getByRole("button", { name: /^发送验证码$/ }).click();
  const response = await waiting;
  expect(response.status(), "Real challenge API accepts the operation").toBe(
    200,
  );
  const body = await parsed(response);
  expect(
    typeof body.challengeId === "string" &&
      typeof body.continuationToken === "string",
  ).toBe(true);
  await expect(codeField(page)).toBeVisible();
  expect((await codeField(page).inputValue()) === "").toBe(true);
  return body;
}

async function enterCode(page: Page, code: string) {
  try {
    await codeField(page).fill(code);
  } catch {
    throw new Error("Verification input could not be filled");
  }
}

async function verify(page: Page, code: string, expectedOutcome?: string) {
  await enterCode(page, code);
  await expect(submit(page)).toBeEnabled();
  const waiting = authResponse(page, "challenges/verify");
  await submit(page).click();
  const response = await waiting;
  const body = await parsed(response);
  if (expectedOutcome) {
    expect(response.status()).toBe(200);
    expect(body.outcome).toBe(expectedOutcome);
  }
  return body;
}

async function signOut(page: Page) {
  const response = await page.request.post("/api/community/auth/sign-out");
  expect([200, 204].includes(response.status())).toBe(true);
  expect((await page.request.get("/api/community/me")).status()).toBe(401);
}

async function openSyntheticComments(page: Page) {
  if (!acceptanceCatalogId)
    throw new Error(
      "AUTH_UI_CATALOG_ID is required for source-context acceptance",
    );
  await page.goto(
    `/?catalogId=${encodeURIComponent(acceptanceCatalogId)}#detail`,
  );
  const detail = page.getByRole("dialog", { name: "资料详情", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  await detail.getByRole("tab", { name: "评论", exact: true }).click();
  await expect(detail.locator("[data-detail-content-pager]")).toHaveAttribute(
    "data-detail-content-active-page",
    "comments",
  );
  await expect(
    detail.locator('[data-comment-section][data-comment-presentation="live"]'),
  ).toBeVisible();
  return detail;
}

async function assertReturnedComments(page: Page, source: string) {
  await expect(page).toHaveURL(source);
  const detail = page.getByRole("dialog", { name: "资料详情", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-detail-state", "loaded");
  await expect(detail.locator("[data-detail-content-pager]")).toHaveAttribute(
    "data-detail-content-active-page",
    "comments",
  );
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.get("/api/community/auth/capabilities");
  expect(response.status(), "A real Development auth server is required").toBe(
    200,
  );
  const body = record(await response.json());
  expect(body.profile).toBe(profile);
  expect(body.developmentOnly).toBe(true);
  expect(record(body.email).available).toBe(true);
  expect(record(body.phone).available).toBe(profile === "full-local");
});

test("explicit registration, existing login, and existing-account register handoff", async ({
  page,
  context,
}, testInfo) => {
  const email = uniqueEmail();
  const destination = `/dev/community?auth-ui-return=${randomBytes(4).toString("hex")}`;
  let registrations = 0;
  let verifications = 0;
  let challenges = 0;
  let commentWrites = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname.endsWith("/auth/registrations"))
      registrations++;
    if (request.method() === "POST" && pathname.endsWith("/auth/challenges"))
      challenges++;
    if (
      request.method() === "POST" &&
      pathname.endsWith("/auth/challenges/verify")
    )
      verifications++;
    if (
      request.method() === "POST" &&
      /^\/api\/catalog\/[^/]+\/comments(?:\/|$)/u.test(pathname)
    )
      commentWrites++;
  });
  await goAuth(page, "register", destination);
  await emptyCodeScreenshot(page, testInfo, "register-account-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await emptyCodeScreenshot(page, testInfo, "register-account-dark.png");
  await page.emulateMedia({ colorScheme: "light" });
  await send(page, email);
  await emptyCodeScreenshot(page, testInfo, "register-code-empty.png");
  const captured = await latestCapture(email);
  await enterCode(page, captured.code);
  await page.waitForTimeout(150);
  expect(
    verifications,
    "Filling six digits does not submit automatically",
  ).toBe(0);
  await verify(page, captured.code, "registration_required");
  await expect(nicknameField(page)).toBeVisible();
  expect(registrations, "Verification alone does not create an account").toBe(
    0,
  );
  expect((await page.request.get("/api/community/me")).status()).toBe(401);
  await nicknameField(page).fill("认证预览访客");
  await expect(submit(page)).toBeDisabled();
  const agreement = page
    .getByRole("button", { name: /注册说明/ })
    .or(page.getByRole("link", { name: /注册说明/ }))
    .first();
  await agreement.click();
  const back = page
    .getByRole("button", { name: /返回(?:注册|资料|填写|上一步|$)/ })
    .or(page.getByRole("link", { name: /返回(?:注册|资料|填写|上一步|$)/ }))
    .first();
  await back.click();
  await expect(nicknameField(page)).toHaveValue("认证预览访客");
  await page.getByRole("checkbox").check();
  const creation = authResponse(page, "registrations");
  await page.getByRole("button", { name: /^创建账户$/ }).click();
  expect((await creation).status()).toBe(201);
  await expect(page).toHaveURL(new URL(destination, page.url()).href);
  expect(registrations).toBe(1);
  expect(challenges, "Explicit creation uses one requested challenge").toBe(1);
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "yoyi-session" && cookie.httpOnly,
    ),
  ).toBe(true);
  expect((await page.request.get("/api/community/me")).status()).toBe(200);
  const commentReturn = Boolean(
    acceptanceCatalogId && testInfo.project.name === "desktop-chromium",
  );
  const draft = "#167 合成评论草稿：仅恢复，不自动发送。";
  let loginDestination = new URL(destination, page.url()).href;
  if (commentReturn) {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSyntheticComments(page);
    await page
      .getByRole("textbox", { name: "写下你的评论", exact: true })
      .fill(draft);
    await page.waitForTimeout(150);
    loginDestination = page.url();
    await signOut(page);
    // Real session refusal and the existing AuthorProvider focus listener
    // expose the product's real sign-in link. No API or identity is mocked.
    const refreshedSession = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/community/me" &&
        response.status() === 401,
      { timeout: 12_000 },
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshedSession;
    await expect(page.locator("[data-comment-signed-out]")).toHaveCount(1, {
      timeout: 12_000,
    });
    // Confirmed sign-out can remount the detail's scoped content pager.
    // Reveal comments again in the same document before using its real entry.
    const detail = page.getByRole("dialog", { name: "资料详情", exact: true });
    await detail.getByRole("tab", { name: "评论", exact: true }).click({
      timeout: 12_000,
    });
    const commentLogin = page
      .locator("[data-comment-signed-out]")
      .getByRole("link", { name: "登录", exact: true });
    await expect(commentLogin).toBeVisible({ timeout: 12_000 });
    await commentLogin.click({ timeout: 12_000 });
    await expect(page).toHaveURL(/\/login\?/);
    await expect(emailField(page)).toBeVisible();
  } else {
    await signOut(page);
    await goAuth(page, "login", destination);
  }
  await send(page, email);
  const loginCapture = await latestCapture(email, new Set([captured.id]));
  await verify(page, loginCapture.code, "signed_in");
  await expect(page).toHaveURL(loginDestination);
  expect(challenges, "Existing login requests one new challenge").toBe(2);
  if (commentReturn) {
    await assertReturnedComments(page, loginDestination);
    await expect(
      page.getByRole("textbox", { name: "写下你的评论", exact: true }),
    ).toHaveValue(draft);
    expect(
      commentWrites,
      "Same-account return restores the draft without posting",
    ).toBe(0);
  }
  expect(registrations).toBe(1);
  await signOut(page);
  await goAuth(page, "register", destination);
  await send(page, email);
  await verify(
    page,
    (await latestCapture(email, new Set([captured.id, loginCapture.id]))).code,
    "already_registered",
  );
  await expect(page).toHaveURL(/\/register\?/);
  expect(
    challenges,
    "Existing-account registration requests one challenge",
  ).toBe(3);
  await expect(modeLink(page, "login")).toBeVisible();
  expect(
    registrations,
    "Existing-account handoff does not create another account",
  ).toBe(1);
  await modeLink(page, "login").click();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(emailField(page)).toHaveValue(email);
  await page.waitForTimeout(150);
  expect(
    challenges,
    "Choosing login does not activate the form's send operation",
  ).toBe(3);
  expect(await codeField(page).count()).toBe(0);
});

test("unknown login requires explicit creation, mode/channel reset, cancel and browser back", async ({
  page,
}, testInfo) => {
  const email = uniqueEmail();
  const source = `/dev/community?auth-ui-source=${randomBytes(4).toString("hex")}`;
  let registrations = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/auth/registrations")
    )
      registrations++;
  });
  await page.goto(source);
  await goAuth(page, "login", source);
  const phone = page.getByRole("button", { name: /^手机(?:登录)?$/ });
  if (profile === "email-first") await expect(phone).toBeDisabled();
  await send(page, email);
  const body = await verify(
    page,
    (await latestCapture(email)).code,
    "registration_required",
  );
  await expect(nicknameField(page)).toBeVisible();
  expect(registrations).toBe(0);
  expect((await page.request.get("/api/community/me")).status()).toBe(401);
  const proof = typeof body.handoffToken === "string" ? body.handoffToken : "";
  expect(proof.length > 0).toBe(true);
  expect(
    await page.evaluate((token) => {
      const values = [
        ...Object.values(localStorage),
        ...Object.values(sessionStorage),
      ];
      return values.some((value) => String(value).includes(token));
    }, proof),
    "Handoff proof remains outside browser storage",
  ).toBe(false);
  await modeLink(page, "register").click();
  await expect(emailField(page)).toHaveValue(email);
  expect(await codeField(page).count()).toBe(0);
  expect(await nicknameField(page).count()).toBe(0);
  if (profile === "full-local") {
    await phone.click();
    await expect(phoneField(page)).toBeVisible();
    expect(await codeField(page).count()).toBe(0);
    await page.getByRole("button", { name: /^邮箱(?:登录)?$/ }).click();
    await expect(emailField(page)).toBeVisible();
  }
  await emptyCodeScreenshot(page, testInfo, "restart-account.png");
  await page
    .getByRole("button", { name: /^(?:取消|返回原页面)$/ })
    .or(page.getByRole("link", { name: /^(?:取消|返回原页面)$/ }))
    .first()
    .click();
  await expect(page).toHaveURL(new URL(source, page.url()).href);
  expect(registrations).toBe(0);
  await goAuth(page, "login", source);
  await modeLink(page, "register").click();
  await page.goBack();
  await expect(page).toHaveURL(new URL(source, page.url()).href);
});

test("wrong code stays recoverable and resend replaces the real challenge", async ({
  page,
}, testInfo) => {
  const email = uniqueEmail();
  await goAuth(page, "login", "/dev/community");
  const firstChallenge = await send(page, email);
  const first = await latestCapture(email);
  const wrong = `${(Number(first.code[0]) + 1) % 10}${first.code.slice(1)}`;
  const wrongResult = await verify(page, wrong);
  expect(record(wrongResult.error).message === "AUTH_CODE_INVALID").toBe(true);
  await expect(page.locator("main").getByRole("alert")).toContainText(
    /验证码.*(?:不正确|错误)/,
  );
  await expect(codeField(page)).toBeVisible();
  await enterCode(page, "");
  await emptyCodeScreenshot(page, testInfo, "wrong-code-empty.png");
  const resend = page
    .getByRole("button", { name: /(?:重新发送|重新获取|重发)/ })
    .first();
  await expect(resend).toBeEnabled({ timeout: 70_000 });
  const waiting = authResponse(page, "challenges");
  await resend.click();
  const response = await waiting;
  expect(response.status()).toBe(200);
  const replacement = await parsed(response);
  expect(typeof replacement.continuationToken === "string").toBe(true);
  expect(replacement.challengeId !== firstChallenge.challengeId).toBe(true);
  const second = await latestCapture(email, new Set([first.id]));
  expect(second.id !== first.id).toBe(true);
  await verify(page, second.code, "registration_required");
  await expect(nicknameField(page)).toBeVisible();
  expect((await page.request.get("/api/community/me")).status()).toBe(401);
});

test("full-local phone uses captured simulated SMS and explicit confirmation", async ({
  page,
}, testInfo) => {
  test.skip(
    profile !== "full-local" || testInfo.project.name !== "desktop-chromium",
    "One real simulated SMS probe preserves the shared 20-send source budget",
  );
  const phone = `139${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`;
  await goAuth(page, "register", "/dev/community");
  await page.getByRole("button", { name: /^手机(?:登录)?$/ }).click();
  await expect(phoneField(page)).toBeVisible();
  await expect(page.locator("main")).toContainText(/\+86/);
  await send(page, phone, "phone");
  const captured = await latestCapture(`+86${phone}`, new Set(), true);
  await verify(page, captured.code, "registration_required");
  await expect(nicknameField(page)).toBeVisible();
  await nicknameField(page).fill("模拟手机访客");
  await page.getByRole("checkbox").check();
  const waiting = authResponse(page, "registrations");
  await page.getByRole("button", { name: /^创建账户$/ }).click();
  expect((await waiting).status()).toBe(201);
  await expect(page).toHaveURL(/\/dev\/community$/);
  expect((await page.request.get("/api/community/me")).status()).toBe(200);
});

test("application login entry restores the visitor profile tab without a reload", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "主要内容" })
    .getByRole("button", { name: "用户", exact: true })
    .click();
  const profileSurface = page.locator(
    '[data-primary-destination="user"][data-active="true"]',
  );
  await expect(profileSurface).toBeVisible();
  await profileSurface.getByRole("tab", { name: "收藏", exact: true }).click();
  await expect(
    profileSurface.getByRole("tab", { name: "收藏", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const source = page.url();
  await page.evaluate(() => {
    Object.defineProperty(window, "__authUiRoundTripMarker", {
      value: "source-document",
      configurable: true,
    });
  });
  await profileSurface.getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await expect(emailField(page)).toBeVisible();
  await page.getByRole("button", { name: /^返回原页面$/ }).click();
  await expect(page).toHaveURL(source);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "__authUiRoundTripMarker") === "source-document",
    ),
  ).toBe(true);
  await expect(profileSurface).toBeVisible();
  await expect(
    profileSurface.getByRole("tab", { name: "收藏", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await profileSurface.getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await page.goBack();
  await expect(page).toHaveURL(source);
  await expect(
    profileSurface.getByRole("tab", { name: "收藏", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("synthetic detail comments tab survives cancel and browser back", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium" || !acceptanceCatalogId,
    "One desktop-engine source-context probe uses the task's explicit synthetic fixture",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openSyntheticComments(page);
  const source = page.url();
  const signedOut = page.locator("[data-comment-signed-out]");
  await signedOut.getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByRole("button", { name: /^返回原页面$/ }).click();
  await assertReturnedComments(page, source);
  await signedOut.getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?/);
  await page.goBack();
  await assertReturnedComments(page, source);
  expect((await page.request.get("/api/community/me")).status()).toBe(401);
});

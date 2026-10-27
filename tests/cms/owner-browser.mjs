import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import {
  editorialDraftSchema,
  editorialContentFromDocument,
} from "@moya/contracts/internal/editorial";

// Run only against a task-created synthetic CMS. The access file is external,
// mode-restricted operator state, never an artifact or command-line secret.
let browser;
let stage = "configuration";
const completed = [];
const responseFailures = [];
const safeNativeFailures = [];
const requestShapeFailures = [];
let clientErrorCount = 0;
let expectedWithdrawalConflict = false;
let withdrawalConflictCount = 0;
let nativeWithdrawalCode;
const startedAt = Date.now();
const checkpoint = (name) =>
  console.log(
    JSON.stringify({
      nativeWithdrawalCheckpoint: name,
      elapsedMs: Date.now() - startedAt,
    }),
  );
try {
  assert.equal(process.env.CMS_ENVIRONMENT, "synthetic");
  const access = JSON.parse(
    await readFile(process.env.CMS_QA_ACCESS_FILE, "utf8"),
  );
  const target = new URL(access.baseURL);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  assert(["http:", "https:"].includes(target.protocol));
  assert(!target.username && !target.password);
  const origin = target.origin;
  stage = "launch";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const showTechnicalField = async (label, selector) => {
    // Native Collapsible lazily mounts its fields; retain the original value assertions.
    if ((await page.locator(selector).count()) === 0) {
      await page
        .locator(".collapsible-field")
        .filter({ hasText: label })
        .locator(".collapsible__toggle")
        .first()
        .click();
    }
    await page.locator(selector).waitFor({ state: "attached" });
  };
  page.on("pageerror", () => {
    clientErrorCount += 1;
  });
  page.on("response", (response) => {
    if (
      expectedWithdrawalConflict &&
      response.status() === 409 &&
      response.request().method() === "PATCH" &&
      response.request().postDataJSON()?._status === "draft" &&
      new URL(response.url()).searchParams.get("draft") === "false"
    ) {
      withdrawalConflictCount += 1;
      return;
    }
    if (response.status() >= 400)
      responseFailures.push({
        status: response.status(),
        type: response.request().resourceType(),
      });
  });
  const requestResult = async (response) => {
    const body = await response.json();
    if (!response.ok()) {
      try {
        const raw = response.request().postData();
        const json = raw.startsWith("{")
          ? raw
          : raw.match(/name="_payload"\r\n\r\n([\s\S]*?)\r\n--/)[1];
        const input = JSON.parse(json);
        const parsed = editorialDraftSchema.safeParse(
          editorialContentFromDocument(input),
        );
        if (!parsed.success)
          requestShapeFailures.push(
            parsed.error.issues.map(({ path }) =>
              path
                .map((part) =>
                  typeof part === "number" ? "row" : String(part),
                )
                .join("."),
            ),
          );
      } catch {
        requestShapeFailures.push(["UNAVAILABLE"]);
      }
      const encoded = JSON.stringify(body);
      safeNativeFailures.push({
        status: response.status(),
        codes: [
          "CONTENT_INVALID",
          "REVISION_REQUIRED",
          "REVISION_INVALID",
          "REVISION_CONFLICT",
          "IDENTITY_IMMUTABLE",
          "IDENTITY_ALREADY_BOUND",
          "TRANSACTION_REQUIRED",
          "CATALOG_OUT_OF_SCOPE",
        ].filter((code) => encoded.includes(code)),
        fields: [
          "kind",
          "title",
          "catalogId",
          "sourceId",
          "revision",
          "description",
          "transcription",
        ].filter((field) => encoded.includes(`"${field}"`)),
      });
    }
    assert(response.ok());
    return body.doc ?? body.result ?? body;
  };
  const saveResponse = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith("/api/catalogs") &&
        ["POST", "PATCH"].includes(response.request().method()),
    );
  stage = "login";
  await page.goto(`${origin}/admin/login`);
  await page.locator('input[name="email"]').fill(access.ownerEmail);
  await page.locator('input[name="password"]').fill(access.ownerPassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/admin");
  completed.push(stage);

  stage = "native-create-renders-before-empty-write";
  await page.goto(`${origin}/admin/collections/catalogs/create`);
  await page.locator('input[name="title"]').waitFor({ state: "visible" });
  assert.equal(
    new URL(page.url()).pathname,
    "/admin/collections/catalogs/create",
  );
  await showTechnicalField("资料详细信息", 'input[name="catalogId"]');
  const catalogId = await page.locator('input[name="catalogId"]').inputValue();
  const sourceId = await page.locator('input[name="sourceId"]').inputValue();
  assert(catalogId && sourceId && catalogId !== sourceId);
  completed.push(stage);

  stage = "native-incomplete-draft-save";
  await page.locator("#field-kind").getByRole("combobox").click();
  await page.getByRole("option", { name: "书法", exact: true }).click();
  const create = saveResponse();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const created = await requestResult(await create);
  assert(created.id && created._status === "draft");
  assert(!created.title);
  await page.waitForURL(
    (url) => url.pathname === `/admin/collections/catalogs/${created.id}`,
  );
  completed.push(stage);

  stage = "native-publish";
  const publishedTitle = `Synthetic browser ${randomUUID()}`;
  await page.locator('input[name="title"]').fill(publishedTitle);
  const publish = saveResponse();
  await page.getByRole("button", { name: "发布修改", exact: true }).click();
  const published = await requestResult(await publish);
  assert.equal(published._status, "published");
  assert.equal(published.title, publishedTitle);
  const main = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  assert.equal(main.title, publishedTitle);
  await showTechnicalField("版本信息", 'input[name="revision"]');
  await expect(page.locator('input[name="revision"]')).toHaveValue(
    String(published.revision),
  );
  completed.push(stage);

  stage = "native-new-draft-preserves-published";
  const draftTitle = `${publishedTitle} draft`;
  const edit = saveResponse();
  await page.locator('input[name="title"]').fill(draftTitle);
  // Existing native documents use Payload's configured autosave. The explicit
  // Save Draft button above is the validated new-document path.
  const draft = await requestResult(await edit);
  stage = "native-autosave-returns-draft";
  assert.equal(draft._status, "draft");
  const unchanged = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  stage = "native-autosave-preserves-main-title";
  assert.equal(unchanged.title, publishedTitle);
  stage = "native-autosave-preserves-main-revision";
  assert.equal(unchanged.revision, published.revision);
  completed.push(stage);

  stage = "owner-batch-approval";
  const account = await requestResult(
    await page.request.post(`${origin}/api/users`, {
      data: {
        email: `browser-${randomUUID()}@example.invalid`,
        password: randomUUID(),
        role: "automation",
        scopeCatalogIds: [catalogId],
      },
    }),
  );
  const summaries = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/editorial/owner-drafts",
  );
  await page.goto(`${origin}/admin/editorial-workflow`);
  const summary = await requestResult(await summaries);
  assert(
    summary.docs.some(
      (row) => row.id === created.id && row.revision === draft.revision,
    ),
  );
  await page
    .getByRole("checkbox", { name: `选择 ${draftTitle}`, exact: true })
    .check();
  await page.getByLabel("执行账号").selectOption(String(account.id));
  const approvalResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/editorial/approve-batch",
  );
  await page.getByRole("button", { name: "核对并批准…", exact: true }).click();
  await page.getByRole("button", { name: "确认批准", exact: true }).click();
  const approval = await requestResult(await approvalResponse);
  assert(approval.approvalId && approval.itemCount === 1);
  await page.getByRole("status").filter({ hasText: "已批准批次" }).waitFor();
  completed.push(stage);

  stage = "owner-history-restores-draft-only";
  await page.getByRole("tab", { name: "版本恢复", exact: true }).click();
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", {
      name: draftTitle,
      exact: true,
    }),
  });
  const historyResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/editorial/owner-history",
  );
  await row.getByRole("button", { name: "查看历史", exact: true }).click();
  const history = await requestResult(await historyResponse);
  assert.equal(history.id, created.id);
  const oldVersion = history.docs.find(
    (version) =>
      version.revision === published.revision && version.status === "published",
  );
  assert(oldVersion);
  await page.getByLabel("历史版本").selectOption(String(oldVersion.id));
  const restoreResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/editorial/restore-draft",
  );
  await page.getByRole("button", { name: "恢复为新草稿", exact: true }).click();
  const restored = await requestResult(await restoreResponse);
  assert.equal(restored.revision, draft.revision + 1);
  const restoredDraft = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=true`,
    ),
  );
  assert.equal(restoredDraft.title, publishedTitle);
  assert.equal(restoredDraft._status, "draft");
  const stillPublished = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  assert.equal(stillPublished.title, publishedTitle);
  assert.equal(stillPublished.revision, published.revision);
  completed.push(stage);

  stage = "native-media-upload-and-draft-preview";
  await page.goto(`${origin}/admin/collections/catalogs/${created.id}`);
  await expect(page.locator('input[name="title"]')).toHaveValue(publishedTitle);
  // The native unnamed tab changes presentation, not the media field paths.
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page.getByRole("button", { name: "上传原图", exact: true }).click();
  const drawer = page.locator(".doc-drawer");
  await drawer.locator('input[name="alt"]').waitFor({ state: "visible" });
  const image = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 3,
      background: { r: 80, g: 120, b: 160 },
    },
  })
    .png()
    .toBuffer();
  await drawer.locator('input[type="file"]').setInputFiles({
    name: "synthetic-browser.png",
    mimeType: "image/png",
    buffer: image,
  });
  await drawer.locator('input[name="alt"]').fill("Synthetic native upload");
  const uploadedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media" &&
      response.request().method() === "POST",
  );
  await drawer.getByRole("button", { name: "保存", exact: true }).click();
  const uploaded = await requestResult(await uploadedResponse);
  assert(uploaded.mediaId && uploaded.objectKey);
  assert.equal(uploaded.catalogId, catalogId);
  assert.equal(uploaded.width, 4);
  assert.equal(uploaded.height, 3);
  await drawer.waitFor({ state: "hidden" });
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${origin}/api/catalogs/${created.id}?depth=0&draft=true`,
      );
      if (!response.ok()) return false;
      const document = await response.json();
      return (
        document.media?.length === 1 &&
        document.media[0].mediaId === uploaded.mediaId
      );
    })
    .toBe(true);
  const mediaDraft = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=true`,
    ),
  );
  assert.equal(mediaDraft.media[0].objectKey, uploaded.objectKey);
  assert.equal(mediaDraft.media[0].isRepresentative, true);
  const preview = await requestResult(
    await page.request.get(`${origin}/api/editorial/preview/${created.id}`),
  );
  assert.equal(preview.media.length, 1);
  assert.equal(preview.media[0].id, uploaded.mediaId);
  assert.equal(preview.media[0].width, 4);
  assert.equal(preview.media[0].height, 3);
  const mediaURL = new URL(preview.media[0].src);
  assert.equal(mediaURL.origin, origin);
  const original = await page.request.get(mediaURL.href);
  assert(original.ok());
  assert.deepEqual(await original.body(), image);
  const publishedAfterMedia = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  assert.equal(publishedAfterMedia.media.length, 0);
  assert.equal(publishedAfterMedia.revision, published.revision);
  completed.push(stage);

  stage = "native-withdrawal-confirmation-and-revision-conflict";
  checkpoint("start-conflict");
  await page.reload();
  await showTechnicalField("版本信息", 'input[name="revision"]');
  await expect(page.locator('input[name="revision"]')).toHaveValue(
    String(mediaDraft.revision),
  );
  const openWithdrawal = async () => {
    await page.locator(".doc-controls__popup .popup-button").click();
    await page.locator("button#action-unpublish").click();
    await page.locator(".confirmation-modal #confirm-action").waitFor();
  };
  const withdrawalRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === `/api/catalogs/${created.id}` &&
      request.method() === "PATCH" &&
      url.searchParams.get("draft") === "false"
    )
      withdrawalRequests.push(request.postDataJSON());
  });
  await openWithdrawal();
  await page.locator(".confirmation-modal #confirm-cancel").click();
  await expect(page.locator(".confirmation-modal")).toHaveCount(0);
  assert.equal(withdrawalRequests.length, 0);

  await openWithdrawal();
  // Another saved draft after confirmation opens must not be silently replaced
  // by looking up a newer revision and retrying the withdrawal.
  const concurrent = await requestResult(
    await page.request.patch(
      `${origin}/api/catalogs/${created.id}?draft=true&depth=0`,
      {
        data: {
          revision: mediaDraft.revision,
          summary: "Synthetic concurrent draft before withdrawal",
          _status: "draft",
        },
      },
    ),
  );
  assert.equal(concurrent.revision, mediaDraft.revision + 1);
  expectedWithdrawalConflict = true;
  const conflictResponse = saveResponse();
  await page.locator(".confirmation-modal #confirm-action").click();
  const conflict = await conflictResponse;
  const conflictBody = JSON.stringify(await conflict.json());
  nativeWithdrawalCode = ["REVISION_REQUIRED", "REVISION_CONFLICT"].find(
    (code) => conflictBody.includes(code),
  );
  assert.equal(conflict.status(), 409);
  assert.equal(nativeWithdrawalCode, "REVISION_CONFLICT");
  await expect(page.locator(".confirmation-modal")).toHaveCount(0);
  expectedWithdrawalConflict = false;
  assert.equal(withdrawalConflictCount, 1);
  assert.deepEqual(withdrawalRequests, [
    { _status: "draft", revision: mediaDraft.revision },
  ]);
  const conflictMain = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  assert.equal(conflictMain._status, "published");
  assert.equal(conflictMain.revision, published.revision);
  checkpoint("conflict-passed");
  completed.push(stage);

  stage = "native-withdrawal-preserves-latest-draft";
  nativeWithdrawalCode = undefined;
  await page.reload();
  await showTechnicalField("版本信息", 'input[name="revision"]');
  await expect(page.locator('input[name="revision"]')).toHaveValue(
    String(concurrent.revision),
  );
  await openWithdrawal();
  checkpoint("final-confirm-open");
  // A successful withdrawal reloads the page. Check its status, then verify
  // the refreshed UI and persisted document instead of reading a stale body.
  const withdrawalResponse = saveResponse();
  await page.locator(".confirmation-modal #confirm-action").click();
  checkpoint("final-confirm-click-returned");
  assert.equal((await withdrawalResponse).status(), 200);
  checkpoint("withdraw-response-ok");
  assert.deepEqual(withdrawalRequests, [
    { _status: "draft", revision: mediaDraft.revision },
    { _status: "draft", revision: concurrent.revision },
  ]);
  await showTechnicalField("版本信息", 'input[name="revision"]');
  await expect(page.locator('input[name="revision"]')).toHaveValue(
    String(concurrent.revision + 1),
  );
  const withdrawnMain = await requestResult(
    await page.request.get(
      `${origin}/api/catalogs/${created.id}?depth=0&draft=false`,
    ),
  );
  assert.equal(withdrawnMain.id, created.id);
  assert.equal(withdrawnMain._status, "draft");
  assert.equal(withdrawnMain.revision, concurrent.revision + 1);
  assert.equal(withdrawnMain.catalogId, catalogId);
  assert.equal(withdrawnMain.sourceId, sourceId);
  assert.equal(withdrawnMain.title, mediaDraft.title);
  assert.equal(withdrawnMain.summary, concurrent.summary);
  // Payload versions generate their own array-row id. Compare every stored
  // media field and its order except that internal row id; MediaId is retained.
  const mediaSnapshots = (rows) =>
    rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")),
    );
  assert.deepEqual(
    mediaSnapshots(withdrawnMain.media),
    mediaSnapshots(mediaDraft.media),
  );
  await page.locator(".doc-controls__popup .popup-button").click();
  await expect(page.locator("#action-unpublish")).toHaveCount(0);
  completed.push(stage);

  assert.equal(clientErrorCount, 0);
  assert.equal(responseFailures.length, 0);
  console.log(JSON.stringify({ ok: true, completed }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      stage,
      completed,
      category: ["AssertionError", "TimeoutError", "Error"].includes(
        error?.name,
      )
        ? error.name
        : "BROWSER_FAILED",
      responseFailures,
      safeNativeFailures,
      requestShapeFailures,
      clientErrorCount,
      nativeWithdrawalCode,
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {
    console.log(
      JSON.stringify({
        ok: false,
        stage: "browser-close",
        category: "BROWSER_FAILED",
      }),
    );
    process.exitCode = 1;
  });
}

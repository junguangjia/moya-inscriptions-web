import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { NotificationItem } from "@moya/contracts";
import {
  discussionPageSchema,
  discussionReplyPageSchema,
  notificationItemSchema,
  notificationPageSchema,
} from "@moya/contracts/schemas";

import { prepareFormalRoutes } from "./support/prepare-formal-routes";
import { addSessionCookie } from "./support/session-cookie";

// Browser-only fixtures. The existing formal fixture serves this Catalog's
// real layout/media; these intercepts supply its private notification journey.
const CATALOG_ID = "runtime-inscription-multi-media";
const TARGET = { type: "catalog" as const, id: CATALOG_ID };
const DISCUSSION = `/api/community/discussion/catalog/${CATALOG_ID}`;
const ROOT_ID = "comment-notification-page-two-root";
const REPLY_ID = "comment-notification-reply-12";
const WITHDRAWN_ID = "comment-notification-withdrawn";
const MISSING_CATALOG = "runtime-notification-deleted";
const PRIVATE_WORK = `work-${"9".repeat(32)}`;
const WHEN = "2026-10-10T00:00:00.000Z";
const viewer = {
  id: `user-${"1".repeat(32)}`,
  handle: "notification-reader",
  displayName: "通知读者",
};
const actor = {
  id: `user-${"2".repeat(32)}`,
  handle: "notification-author",
  displayName: "通知作者",
};
const passage = "笔势开张而结体端严，碑阴题名尤可玩味。".repeat(5);
type Filter = "all" | "likes" | "comments" | "mentions";

const notification = (
  n: number,
  reason: NotificationItem["reason"],
  commentId: string | null,
  overrides: Record<string, unknown> = {},
) =>
  notificationItemSchema.parse({
    id: `notification-${n.toString(16).padStart(32, "0")}`,
    reason,
    available: true,
    target: TARGET,
    commentId,
    actors: [actor],
    actorCount: 1,
    text: commentId === REPLY_ID ? "第二页回复定位" : "通知导航回归",
    createdAt: WHEN,
    unread: true,
    observation: `item-${n}`,
    ...overrides,
  });

const CONTENT_LIKE = notification(1, "like", null);
const ROOT_COMMENT = notification(2, "comment", ROOT_ID);
const PAGED_REPLY = notification(3, "reply", REPLY_ID);
const UNAVAILABLE = notification(4, "comment", null, {
  available: false,
  target: null,
  actors: [],
  actorCount: 0,
  text: "",
});
const DELETED_CONTENT = notification(5, "like", null, {
  target: { type: "catalog", id: MISSING_CATALOG },
});
const INACCESSIBLE_WORK = notification(6, "like", null, {
  target: { type: "work", id: PRIVATE_WORK },
});
const WITHDRAWN_COMMENT = notification(7, "reply", WITHDRAWN_ID);

const reply = (n: number) => ({
  id: `comment-notification-reply-${n}`,
  author: { id: actor.id, displayName: actor.displayName },
  text: n === 12 ? "第二页回复定位：应打开这一条。" : `前序回复 ${n}。`,
  createdAt: WHEN,
  replyTo: { id: viewer.id, displayName: viewer.displayName },
  likeCount: 0,
  liked: false,
  deleted: false,
});
const comment = (id: string, text: string, withReplies = false) => ({
  id,
  target: TARGET,
  author: { id: actor.id, displayName: actor.displayName },
  text,
  createdAt: WHEN,
  likeCount: 0,
  liked: false,
  deleted: false,
  replies: withReplies ? [reply(1), reply(2), reply(3)] : [],
  replyTotal: withReplies ? 12 : 0,
  replyPageTotal: withReplies ? 12 : 0,
});
const discussion = (page: number) =>
  discussionPageSchema.parse({
    visibleTotal: 23,
    hot: [],
    items:
      page === 1
        ? Array.from({ length: 10 }, (_, n) =>
            comment(`comment-notification-first-${n}`, `前页 ${n}：${passage}`),
          )
        : [comment(ROOT_ID, `第二页根评论：${passage}`, true)],
    total: 11,
    page,
    pageSize: 10,
    totalPages: 2,
  });

interface Fixture {
  readonly requests: { pathname: string; search: string }[];
  readonly reads: string[];
}

async function installFixture(
  page: Page,
  unavailable = false,
): Promise<Fixture> {
  const baseURL = test.info().project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Missing E2E base URL");
  // At wide widths the initial server render needs a session hint before
  // the mocked /me answer can establish the signed-in product surface.
  await addSessionCookie(page.context(), baseURL);
  const items = unavailable
    ? [UNAVAILABLE, DELETED_CONTENT, INACCESSIBLE_WORK, WITHDRAWN_COMMENT]
    : [CONTENT_LIKE, ROOT_COMMENT, PAGED_REPLY];
  const read = new Set<string>();
  const observations = new Map<string, string[]>();
  const requests: Fixture["requests"] = [];
  const reads: string[] = [];
  const accepts = (item: NotificationItem, filter: Filter) =>
    filter === "all" ||
    (filter === "likes"
      ? item.reason === "like"
      : filter === "mentions"
        ? item.reason === "mention"
        : item.reason === "comment" || item.reason === "reply");
  for (const item of items) observations.set(item.observation, [item.id]);

  await page.route("**/api/community/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({ pathname: path, search: url.search });
    if (path === "/api/community/me") return route.fulfill({ json: viewer });
    if (path === "/api/community/notifications/stream") return route.abort();
    if (path === "/api/community/notifications/read") {
      const body = request.postDataJSON() as { observation?: unknown };
      const token =
        typeof body.observation === "string" ? body.observation : "";
      const observed = observations.get(token);
      if (request.method() !== "POST" || observed === undefined)
        return route.fulfill({ status: 422, json: { error: {} } });
      reads.push(token);
      observed.forEach((id) => read.add(id));
      return route.fulfill({ json: { read: true } });
    }
    if (path === "/api/community/notifications") {
      const filter = (url.searchParams.get("filter") ?? "all") as Filter;
      const selected = items.filter((item) => accepts(item, filter));
      const token = `page-${filter}`;
      observations.set(
        token,
        selected.map((item) => item.id),
      );
      const unread = (category: Filter) =>
        items.filter((item) => accepts(item, category) && !read.has(item.id))
          .length;
      return route.fulfill({
        json: notificationPageSchema.parse({
          observation: token,
          items: selected.map((item) => ({
            ...item,
            unread: !read.has(item.id),
          })),
          nextCursor: null,
          unread: {
            total: unread("all"),
            likes: unread("likes"),
            comments: unread("comments"),
            mentions: unread("mentions"),
          },
        }),
      });
    }
    if (path === "/api/community/messages/unread")
      return route.fulfill({ json: { unreadConversations: 0 } });
    if (path === "/api/community/messages")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    const profile = path.match(/^\/api\/community\/authors\/([^/]+)$/u);
    if (profile) {
      const person = profile[1] === viewer.id ? viewer : actor;
      return route.fulfill({
        json: {
          ...person,
          bio: "合成通知导航回归资料。",
          avatar: null,
          isOwner: person.id === viewer.id,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "public",
            likes: "public",
          },
          totals: {
            works: 0,
            following: 0,
            followers: 0,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        },
      });
    }
    if (/^\/api\/community\/content\/(catalog|work)\/[^/]+\/state$/u.test(path))
      return route.fulfill({
        json: {
          favorite: false,
          liked: false,
          favoriteCount: 0,
          likeCount: 0,
          commentCount: 23,
        },
      });
    if (
      path === `/api/community/content/catalog/${MISSING_CATALOG}/card` ||
      path === `/api/community/content/work/${PRIVATE_WORK}/card`
    )
      return route.fulfill({ status: 404, json: { error: {} } });
    if (path.startsWith(`${DISCUSSION}/locate/`)) {
      const id = decodeURIComponent(path.slice(`${DISCUSSION}/locate/`.length));
      if (id !== ROOT_ID && id !== REPLY_ID)
        return route.fulfill({ status: 404, json: { error: {} } });
      // Both the click preflight and the mounted discussion revalidate.
      return route.fulfill({
        json: { rootId: ROOT_ID, page: 2, replyPage: id === REPLY_ID ? 2 : 1 },
      });
    }
    if (path === `${DISCUSSION}/replies/${ROOT_ID}`) {
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const numbers =
        pageNumber === 1
          ? Array.from({ length: 10 }, (_, n) => n + 1)
          : [11, 12];
      return route.fulfill({
        json: discussionReplyPageSchema.parse({
          visibleTotal: 12,
          items: numbers.map(reply),
          total: 12,
          page: pageNumber,
          pageSize: 10,
          totalPages: 2,
        }),
      });
    }
    if (path === DISCUSSION)
      return route.fulfill({
        json: discussion(Number(url.searchParams.get("page") ?? "1")),
      });
    // Keep the existing deterministic Catalog details, media and card routes.
    return route.continue();
  });
  return { requests, reads };
}

const trigger = (page: Page) =>
  page.locator(
    '[data-primary-destination="home"][data-active="true"] [data-live-message-trigger]',
  );
const messageDialog = (page: Page, category: "likes" | "comments") =>
  page.getByRole("dialog", {
    name: category === "likes" ? "赞和收藏" : "评论",
    exact: true,
  });

async function openCategory(page: Page, category: "likes" | "comments") {
  await trigger(page).click();
  const home = page.getByRole("dialog", { name: "消息", exact: true });
  await expect(home).toBeVisible();
  await home
    .getByRole("button", {
      name: category === "likes" ? /^赞和收藏/u : /^评论/u,
    })
    .click();
  const dialog = messageDialog(page, category);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeCategory(page: Page, category: "likes" | "comments") {
  await messageDialog(page, category)
    .getByRole("button", { name: "返回", exact: true })
    .click();
  const home = page.getByRole("dialog", { name: "消息", exact: true });
  await expect(home).toBeVisible();
  await home.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(trigger(page)).toBeVisible();
  expect(
    await trigger(page).evaluate((node) => node.closest("[inert]") === null),
  ).toBe(true);
}

async function openNotification(dialog: Locator, item: NotificationItem) {
  const row = dialog.locator(`[data-notification-id="${item.id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button").filter({ hasText: "查看原内容" }).click();
}

// Visibility must be measured without scrolling the target in the test.
// toBeVisible alone permits offscreen DOM and misses the original defect.
async function expectLocatedInViewport(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate((node) => {
        const detail = node.closest<HTMLElement>("[data-detail-state]");
        const outer = node.closest<HTMLElement>("[data-detail-scroll]");
        if (detail === null || outer === null) return false;
        const text =
          node.querySelector<HTMLElement>("[data-colophon-text]") ??
          node.querySelector<HTMLElement>(
            ":scope > div > [data-comment-reply-action]",
          ) ??
          node;
        const box = text.getBoundingClientRect();
        const viewport = outer.getBoundingClientRect();
        const strip = node
          .closest("[data-detail-reading-strip]")
          ?.getBoundingClientRect();
        const header = detail.querySelector("header")?.getBoundingClientRect();
        const readingNavigation = detail
          .querySelector("[data-detail-reading-navigation]")
          ?.getBoundingClientRect();
        const left = Math.max(0, viewport.left, strip?.left ?? 0);
        const right = Math.min(
          innerWidth,
          viewport.right,
          strip?.right ?? innerWidth,
        );
        const top = Math.max(
          0,
          viewport.top,
          header?.bottom ?? 0,
          readingNavigation?.bottom ?? 0,
        );
        const bottom = Math.min(innerHeight, viewport.bottom);
        return (
          Math.min(box.right, right) - Math.max(box.left, left) > 2 &&
          Math.min(box.bottom, bottom) - Math.max(box.top, top) > 2
        );
      }),
    )
    .toBe(true);
}

async function assertDetailMode(page: Page, preference: "single" | "double") {
  const detail = page.locator('[data-detail-state="loaded"]');
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`catalogId=${CATALOG_ID}.*#detail$`, "u"),
  );
  const calligraphy = preference === "single";
  await expect(detail).toHaveAttribute(
    "data-detail-mode",
    calligraphy ? "calligraphy" : "normal",
  );
  await expect(page.locator("[data-product-shell]")).toHaveAttribute(
    "data-feed-layout",
    preference,
  );
  expect(
    await page.evaluate(() => localStorage.getItem("yoyi.home-feed-layout.v2")),
  ).toBe(preference);
  return { detail, calligraphy };
}

test.beforeAll(async ({ request }) => {
  await prepareFormalRoutes(request);
});

for (const preference of ["single", "double"] as const) {
  test(`notification clicks retain ${preference} preference and locate root/reply across Back and close`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((value) => {
      localStorage.setItem("yoyi.home-feed-layout.v2", value);
      localStorage.setItem("yoyi.desktop-feed-layout.v1", value);
    }, preference);
    const fixture = await installFixture(page);
    await page.goto("/");
    await expect(page.locator("[data-product-boot]")).toHaveCount(0);
    await expect(page.locator("[data-product-shell]")).toHaveAttribute(
      "data-browse-only",
      "false",
    );

    // A content like resolves its card and opens the same selected Detail mode.
    await openNotification(await openCategory(page, "likes"), CONTENT_LIKE);
    const like = await assertDetailMode(page, preference);
    expect(
      fixture.requests.some(
        ({ pathname }) =>
          pathname === `/api/community/content/catalog/${CATALOG_ID}/card`,
      ),
    ).toBe(true);
    await like.detail
      .getByRole("button", { name: "返回", exact: true })
      .click();
    await expect(messageDialog(page, "likes")).toBeVisible();
    await closeCategory(page, "likes");

    // Both roots and replies live beyond the initial discussion page. Click
    // through the actual notification host; never repair it by scrolling here.
    for (const item of [ROOT_COMMENT, PAGED_REPLY]) {
      const begin = fixture.requests.length;
      await openNotification(await openCategory(page, "comments"), item);
      const { detail, calligraphy } = await assertDetailMode(page, preference);
      const located = detail.locator(
        calligraphy
          ? `[data-colophon-anchor="${item.commentId}"]`
          : item === ROOT_COMMENT
            ? `[data-comment-id="${item.commentId}"]`
            : `[data-comment-reply="${item.commentId}"]`,
      );
      await expect(located).toHaveCount(1);
      await expect(located).toHaveAttribute(
        calligraphy ? "data-colophon-highlight" : "aria-current",
        "true",
      );
      await expectLocatedInViewport(located);
      const journey = fixture.requests.slice(begin);
      expect(
        journey.filter(
          ({ pathname }) =>
            pathname === `${DISCUSSION}/locate/${item.commentId}`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        journey.some(
          ({ pathname, search }) =>
            pathname === DISCUSSION &&
            new URLSearchParams(search).get("page") === "2",
        ),
      ).toBe(true);
      if (item === PAGED_REPLY)
        expect(
          journey.some(
            ({ pathname, search }) =>
              pathname === `${DISCUSSION}/replies/${ROOT_ID}` &&
              new URLSearchParams(search).get("page") === "2",
          ),
        ).toBe(true);
      if (calligraphy)
        await expect(
          detail.locator(
            '[data-detail-reading-strip]:not([data-detail-reading-variant="desktop-information"])',
          ),
        ).toHaveAttribute("data-detail-reading-region", "comments");
      else if (await detail.locator("[data-detail-content-pager]").count())
        await expect(
          detail.locator("[data-detail-content-pager]"),
        ).toHaveAttribute("data-detail-content-active-page", "comments");

      if (item === ROOT_COMMENT) await page.goBack();
      else {
        await page.screenshot({
          path: info.outputPath(`notification-${preference}-reply.png`),
        });
        await detail.getByRole("button", { name: "返回", exact: true }).click();
      }
      await expect(messageDialog(page, "comments")).toBeVisible();
      await expect(page.locator("[data-detail-state]")).toHaveCount(0);
      await closeCategory(page, "comments");
    }
    // The final reopen proves that no hidden modal/inert layer owns the page.
    await openCategory(page, "comments");
    await page.goBack();
    await expect(
      page.getByRole("dialog", { name: "消息", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(trigger(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("unavailable, deleted, withdrawn and inaccessible notification targets stay in their message category", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await installFixture(page, true);
  await page.goto("/");
  await expect(page.locator("[data-product-boot]")).toHaveCount(0);
  await expect(page.locator("[data-product-shell]")).toHaveAttribute(
    "data-browse-only",
    "false",
  );

  const likes = await openCategory(page, "likes");
  for (const item of [DELETED_CONTENT, INACCESSIBLE_WORK]) {
    const expectedPath = `/api/community/content/${item.target!.type}/${item.target!.id}/card`;
    const refusal = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === expectedPath &&
        response.status() === 404,
    );
    await openNotification(likes, item);
    await refusal;
    await expect(
      likes.getByText("原内容或评论已不可用", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-detail-state]")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("catalogId")).toBe(false);
    expect(new URL(page.url()).searchParams.has("workId")).toBe(false);
  }
  await closeCategory(page, "likes");
  const comments = await openCategory(page, "comments");
  const unavailableRow = comments.locator(
    `[data-notification-id="${UNAVAILABLE.id}"]`,
  );
  await expect(unavailableRow).toHaveText("原内容或评论已不可用");
  await expect(unavailableRow.getByRole("button")).toHaveCount(0);
  await openNotification(comments, WITHDRAWN_COMMENT);
  await expect(
    comments.getByRole("status").filter({ hasText: "原内容或评论已不可用" }),
  ).toBeVisible();
  await expect(page.locator("[data-detail-state]")).toHaveCount(0);
  expect(
    fixture.requests.some(
      ({ pathname }) => pathname === `${DISCUSSION}/locate/${WITHDRAWN_ID}`,
    ),
  ).toBe(true);
  await closeCategory(page, "comments");
  expect(errors).toEqual([]);
});

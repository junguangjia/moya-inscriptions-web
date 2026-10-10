import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const viewer = {
  id: `user-${"1".repeat(32)}`,
  handle: "synthetic-viewer",
  displayName: "私信测试读者",
};
const participant = {
  id: `user-${"2".repeat(32)}`,
  handle: "synthetic-participant",
  displayName: "私信测试作者",
};
const workId = `work-${"3".repeat(32)}`;
const work = {
  id: workId,
  authorId: participant.id,
  authorName: participant.displayName,
  title: "私信导航测试作品",
  text: "从作品详情打开作者主页，再发起私信。",
  media: [],
  firstPublishedAt: "2026-10-10T00:00:00.000Z",
  version: 1,
  canEdit: false,
  available: true,
};
const conversation = {
  id: `dm-${"4".repeat(32)}`,
  participant: {
    id: participant.id,
    displayName: participant.displayName,
    available: true,
  },
  state: "active",
  canSend: true,
  sendRefusal: null,
  lastMessage: null,
  unreadCount: 0,
  muted: false,
  hidden: false,
  readSequence: 0,
  createdAt: "2026-10-10T00:00:00.000Z",
};

async function fixture(page: Page, existing = false) {
  const sends: string[] = [];
  await page.route("**/api/community/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/community/",
      "",
    );
    if (route.request().method() !== "GET") {
      sends.push(path);
      return route.fulfill({ status: 400, json: { error: {} } });
    }
    if (path === "me") return route.fulfill({ json: viewer });
    if (path === `authors/${participant.id}`)
      return route.fulfill({
        json: {
          ...participant,
          bio: "合成私信导航回归资料。",
          avatar: null,
          isOwner: false,
          following: false,
          privacy: {
            following: "public",
            followers: "public",
            favorites: "public",
            likes: "public",
          },
          totals: {
            works: 1,
            following: 0,
            followers: 0,
            favorites: 0,
            likes: 0,
          },
          nextAvatarChangeAt: null,
        },
      });
    if (path === `works/${workId}`) return route.fulfill({ json: work });
    if (path === `authors/${participant.id}/works`)
      return route.fulfill({
        json: { items: [work], total: 1, page: 1, pageSize: 12 },
      });
    if (path === "discover")
      return route.fulfill({
        json: {
          items: [
            {
              target: { type: "work", id: workId },
              title: "私信导航测试作品",
              excerpt: "从作品详情打开作者主页，再发起私信。",
              aliases: [],
              kind: null,
              authorId: participant.id,
              firstPublishedAt: "2026-10-10T00:00:00.000Z",
              media: null,
            },
          ],
          sequence: "11111111-1111-4111-8111-111111111111",
          nextAfter: 1,
          hasMore: false,
        },
      });
    if (path === "messages/unread")
      return route.fulfill({ json: { unreadConversations: 0 } });
    if (path === `messages/with/${participant.id}`)
      return route.fulfill({
        json: { conversation: existing ? conversation : null },
      });
    if (path === "messages")
      return route.fulfill({
        json: { items: existing ? [conversation] : [], nextCursor: null },
      });
    if (path === `messages/${conversation.id}`)
      return route.fulfill({
        json: { conversation, items: [], nextBefore: null },
      });
    if (path.endsWith("/comments"))
      return route.fulfill({
        json: {
          visibleTotal: 0,
          hot: [],
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          totalPages: 0,
        },
      });
    return route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 12 },
    });
  });
  return sends;
}

for (const source of [
  "home",
  "detail",
  "nested-profile",
  "messages",
] as const) {
  for (const existing of source === "messages" ? [true] : [false, true]) {
    test(`profile private message opens a ${existing ? "canonical" : "new"} conversation from ${source}`, async ({
      page,
    }) => {
      const sends = await fixture(page, existing);
      await page.goto(
        source === "home" || source === "nested-profile"
          ? `/?authorId=${participant.id}#profile`
          : "/",
      );
      await expect(page.locator("[data-product-boot]")).toHaveCount(0);
      if (source === "messages") {
        await page
          .getByRole("button", { name: "打开消息", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: `打开与${participant.displayName}的私信`,
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: `查看${participant.displayName}的主页` })
          .click();
      }
      if (source === "detail" || source === "nested-profile") {
        await page
          .locator(`[data-content-id="${workId}"]`)
          .getByRole("button", { name: /打开/u })
          .click();
        await expect(page.locator("[data-detail-state=loaded]")).toBeVisible();
        await page
          .getByRole("button", { name: participant.displayName })
          .click();
      }
      await page
        .getByRole("button", { name: `给 ${participant.displayName} 发私信` })
        .click();
      const dialog = page.getByRole("dialog", {
        name: participant.displayName,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("textbox", { name: "私信内容" }),
      ).toBeEditable();
      await expect(
        dialog.locator(
          existing
            ? `[data-dm-conversation="${conversation.id}"]`
            : `[data-dm-start="${participant.id}"]`,
        ),
      ).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await expect(
        page.locator(`[data-author-profile="${participant.id}"]`),
      ).toHaveCount(0);
      expect(sends).toEqual([]);
      await dialog.getByRole("button", { name: "返回", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "消息", exact: true }),
      ).toBeVisible();
    });
  }
}
